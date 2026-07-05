# Sigenergy (SigenStor) Modbus TCP Protocol Reference

Reference for building a Modbus TCP client against a residential Sigenergy SigenStor
hybrid inverter + battery system (a "Hybrid Inv." device in Sigenergy's own terminology).

**Primary source**: the official *Sigenergy Modbus Protocol* PDF. Sigenergy revises this
document frequently. Two versions were fully read for this doc:

- **V2.9, released 2026‑05‑13** (current at time of writing; 65 pages) — obtained from a
  copy checked into the `TypQxQ/Sigenergy-Local-Modbus` Home Assistant integration repo at
  `Modbus_reference_documentation/Sigenergy Modbus Protocol EN_V2.9.pdf`.
- **V2.7, released 2025‑05‑23** (39 pages) — obtained from Sigenergy's own download CDN
  (`sigenergy.com/uploads/us_download/...pdf`) and independently from
  `Si-GCG/sigenergy_projects` on GitHub.

Where the two versions agree, the content is high‑confidence. Where V2.9 added or changed
something, it is noted explicitly. **Confidence level: high for register addresses, types,
gain and the wire‑format quirks below (each is backed by an official worked example);
medium for anything marked UNVERIFIED (mostly the heartbeat/watchdog question, which the
official document does not address at all).**

Sigenergy ships new protocol revisions every 1–3 months (V1.0 in 2023 through V2.9 in
2026‑05, see the changelog table on page 1 of the PDF). **Before writing a production
client, re-fetch the latest PDF and diff it against this document** — see the "Protocol
version drift" quirk below.

---

## 1. Connection details

| Item | Value |
|---|---|
| Transport | Modbus TCP (also RS485 RTU, same register map) |
| Default port | **502** |
| Link layer | TCP Server (the SigenStor listens; you connect to it) — RTU: half‑duplex, 9600 bps default, 8 data bits, no parity, 1 stop bit |
| **Plant address** (slave/unit ID) | **247** — send here to read/write plant‑level (30000/40000‑series) registers |
| **Plant broadcast address** | **0** — same effect as 247 for writes, but the device does **not** reply (fire‑and‑forget) |
| Per‑device slave ID | 1–246, one unique ID per physical device (inverter, AC‑charger, PV inverter, EVAC, etc.) in the plant, configured via the mySigen installer app |
| Minimum request period | 1000 ms between unicast requests to the same slave (protocol §4.2); increase on lossy RS485 runs |

**Single-inverter home system note (UNVERIFIED, community-sourced):** if there is no AC
charger, the hybrid inverter itself is commonly left at Modbus device ID **1** by factory
default. If an AC (EV) charger is present, convention is: AC‑charger = device ID **1**,
inverter(s) = ID **2, 3, …** (source: `TypQxQ/Sigenergy-Local-Modbus` README, "Known
Limitations" section — "AC chargers are normally device ID `1`; inverters must use another
ID"). Always confirm the actual configured ID in the mySigen installer app rather than
assuming.

To read/write **plant-wide** aggregates (total PV power, total battery power/SOC, grid
import/export, EMS mode, remote EMS control) use slave address **247** regardless of how
many inverters are in the plant. To read **per‑inverter** detail (phase voltages, PV string
data, per-unit alarms) use that inverter's own 1–246 slave ID.

---

## 2. Function codes — **read this before writing any client code**

| Function code | Official V2.7 section title | Official V2.9 section title | Used for reading... |
|---|---|---|---|
| **0x03** | "Read Read-only Register" | "Read Holding Register" | Addresses in the **30000/31000/32000** ranges |
| **0x04** | "Read Holding Register" | "Read Input Register" | Addresses in the **40000/41000/42000** ranges |
| 0x06 | Write a single Register | Write a single Register | Any single RW/WO register |
| 0x10 | Write multiple Registers | Write multiple Registers | Any RW/WO register range |

### Critical quirk: Sigenergy's own section titles for 0x03/0x04 contradict themselves across versions — trust the worked examples, not the titles

This is the single most important gotcha in the whole document. Sigenergy's PDF has an
internal inconsistency that **persists identically from V2.7 through V2.9**:

- Table 4‑1 ("Technical item name specification") says: *"RO: Read only, only support 0x04
  command"* and *"RW: ... support 0x04, 0x06, 0x10 command"* (no 0x03 at all for RW).
- But chapter 6's function-code tables and worked hex examples say the opposite, and are
  **byte-for-byte identical in both V2.7 and V2.9**:

  > **Example (labelled "Read Read-only Register" in V2.7 / "Read Holding Register" in
  > V2.9):** Read the *Rated active power* register (address **30540**, an RO/input
  > register per the register tables) of the hybrid inverter at slave address 1.
  > Host Query: `01 03 77 4C 00 02` — Slave Response: `01 03 04 00 00 61 A8`
  > (`0x774C` = 30540 decimal; function code is **0x03**.)

  > **Example (labelled "Read Holding Register" in V2.7 / "Read Input Register" in V2.9):**
  > Read the *Active power fixed adjustment target value* register (address **40001**, an
  > RW/holding register) of a power plant at slave address 247.
  > Host Query: `F7 04 9C 41 00 02` — Slave Response: `F7 04 04 00 00 61 A8`
  > (`0x9C41` = 40001 decimal; function code is **0x04**.)

Sigenergy appears to have **swapped the section labels** ("Holding" ↔ "Input") between
protocol versions while keeping the exact same function code assignments and the exact same
worked examples. **The wire behavior is stable and is what matters for an implementation:**

> **Use function code 0x03 for every register address in the 30000/31000/32000 ranges
> (plant/inverter/AC‑charger "running information" registers). Use function code 0x04 for
> every register address in the 40000/41000/42000/50000 ranges ("parameter setting"
> registers — the ones you write to control the system).**

This matches standard third-party client behavior (e.g. pymodbus `read_holding_registers`
vs `read_input_registers` — pick whichever call in your library issues the FC you need, not
whichever name matches Sigenergy's prose). Function codes 0x06 (write single) and 0x10
(write multiple) are unambiguous and unchanged.

### Exception codes

| Code | Name | Meaning |
|---|---|---|
| 0x01 | ILLEGAL FUNCTION | Function code not supported by this register/device |
| 0x02 | ILLEGAL DATA ADDRESS | Address/length combination invalid (e.g. register doesn't exist on your firmware/model) |
| 0x03 | ILLEGAL DATA VALUE | Value out of the structurally-valid range |
| 0x04 | SLAVE DEVICE FAILURE | Unrecoverable error while processing |

A common real-world case of 0x02: newer registers (e.g. `30281` Merged Alarm7, added in a
later revision) return exception 0x02 on older firmware that predates that register —
treat this as "unsupported register on this firmware", not a fatal integration error.

---

## 3. Data types, scaling, and encoding

| Type | Meaning |
|---|---|
| U16 / S16 | Unsigned/signed 16-bit — 1 register |
| U32 / S32 | Unsigned/signed 32-bit — 2 registers |
| U64 | Unsigned 64-bit — 4 registers |
| STRING | ASCII, N registers = 2N bytes |
| BIT16 | Bit-mapped 16-bit flags (added V2.9, used for some alarm merges) |
| RO | Read-only (function code 0x03 per §2 above) |
| WO | Write-only (function code 0x06) |
| RW | Read/write (0x03 or 0x04 to read per §2, 0x06/0x10 to write) |

**Scaling ("Gain" column):** actual value = raw register value ÷ Gain. E.g. Gain 1000 with
unit kW means the raw integer is in **watts**; Gain 10 with unit % means raw value is
**tenths of a percent** (e.g. raw `685` = 68.5%). Gain "N/A" (mode/enum/status registers) or
"1" (epoch seconds, plain counts) means no scaling.

**Word order (multi-register values) — CONFIRMED big-endian / high-word-first ("ABCD"):**
Both worked examples above demonstrate this directly. Reading 2 registers for *Rated active
power* (U32, gain 1000) returns bytes `00 00 61 A8`: high register = `0x0000`, low register
= `0x61A8` = 25000 decimal → 25.000 kW. The high-order register is transmitted **first**,
and within each register the byte order is big-endian, consistent with standard Modbus
16-bit register convention. Writing follows the same order (see the "Write multiple
Registers" example: `F7 10 9C 41 00 02 04 00 00 61 A8`). This was verified identically in
both V2.7 and V2.9 documents. **U64 (4-register) values are not shown in a worked example**
but by extension/consistency should follow the same high-word-first ordering — verify this
against real hardware before trusting large energy counters (e.g. `30196` Total generation
of third-party inverter, U64) blindly.

**RTU-specific note:** the CRC16 error-check field byte order is **little-endian**
("little-end mode" per the protocol doc) — this is standard Modbus RTU CRC behavior, called
out explicitly because everything else in the frame is big-endian.

**Register addressing:** addresses in the tables are the literal wire addresses (e.g.
`30540`, `40001`) — there is **no** legacy Modicon 4xxxx/3xxxx offset-by-one convention to
apply. `0x774C` = 30540 exactly.

---

## 4. Plant-level read registers (function code 0x03, slave address 247)

All addresses below are from Table 5‑1 "Plant running information register definition"
(input/read‑only registers). "Hybrid Inv." / "PV Inv." columns indicate which plant types
expose the register — a residential SigenStor plant is "Hybrid Inv.".

| Addr | Name | Type | Gain | Unit | Comment |
|---|---|---|---|---|---|
| 30000 | System time | U32 | 1 | s | Epoch seconds |
| 30002 | System time zone | S16 | 1 | min | |
| 30003 | **EMS work mode** | U16 | N/A | N/A | 0: Max self consumption; 1: AI Mode; 2: TOU; 5: Full Feed-in to Grid; 7: **Remote EMS mode**; 9: Custom |
| 30004 | [Grid Sensor] Status | U16 | N/A | N/A | 0: not connected; 1: connected |
| 30005 | [Grid sensor] Active power | S32 | 1000 | kW | **>0 = buy from grid (import); <0 = sell to grid (export)** |
| 30007 | [Grid sensor] Reactive power | S32 | 1000 | kVar | |
| 30009 | On/Off Grid status | U16 | N/A | N/A | 0: on grid; 1: off grid (auto); 2: off grid (manual) |
| 30010 | Max active power | U32 | 1000 | kW | Base value for active-power adjustment actions |
| 30012 | Max apparent power | U32 | 1000 | kVar | Base value for reactive-power adjustment actions |
| 30014 | **[ESS] SOC** | U16 | 10 | % | Battery state of charge |
| 30015–30026 | Plant phase A/B/C active & reactive power | S32 | 1000 | kW/kVar | Per-phase breakdown |
| 30027–30030 | Merged/General Alarm 1–4 | U16 | N/A | N/A | Bitfields, see Appendices 2–5 of the PDF |
| 30031 | **Plant active power** | S32 | 1000 | kW | Overall plant AC active power |
| 30033 | Plant reactive power | S32 | 1000 | kVar | |
| 30035 | **Photovoltaic power** | S32 | 1000 | kW | Total PV power |
| 30037 | **[ESS] Power** | S32 | 1000 | kW | **<0 = discharging; >0 = charging** |
| 30039/30041 | Available max/min active power | U32 | 1000 | kW | Feed-to-AC / absorb-from-AC limits; running inverters only |
| 30043/30045 | Available max/min reactive power | U32 | 1000 | kVar | |
| 30047/30049 | [ESS] Available max charging/discharging power | U32 | 1000 | kW | Running inverters only |
| 30051 | **Plant running state** | U16 | N/A | N/A | See §7 below (Appendix 1) |
| 30052–30063 | [Grid sensor] per-phase active/reactive power | S32 | 1000 | kW/kVar | Same >0 import/<0 export convention |
| 30064/30066 | [ESS] Available max charging/discharging capacity | U32 | 100 | kWh | Running inverters only |
| 30068/30070 | [ESS] Rated charging/discharging power | U32 | 1000 | kW | |
| 30072 | Merged Alarm5 | U16 | N/A | N/A | See Appendix 11 |
| 30083 | [ESS] Rated energy capacity | U32 | 100 | kWh | |
| 30085 | **[ESS] Charge Cut-Off SOC** | U16 | 10 | % | Read-only mirror of the settable value at 40047 |
| 30086 | **[ESS] Discharge Cut-Off SOC** | U16 | 10 | % | Read-only mirror of 40048 |
| 30087 | [ESS] SOH | U16 | 10 | % | Weighted average across all ESS units |
| 30088 | Plant PV total generation | U64 | 100 | kWh | |
| 30092 | Total load daily consumption | U32 | 100 | kWh | |
| 30094 | Total load consumption | U64 | 100 | kWh | |
| 30098–30144 | [Smart load 1–24] Total consumption | U32 ×24 | 100 | kWh | Per smart-load-circuit energy |
| 30146–30192 | [Smart load 1–24] Power | S32 ×24 | 1000 | kW | Per smart-load-circuit instantaneous power |
| 30194 | Third party inverter active power | S32 | 1000 | kW | Added V2.7 |
| 30196–30268 | Cumulative energy interface (imported/exported/ESS charge-discharge/EVAC/EVDC/oil-generator, etc.) | U64 ×many | 100 | kWh | "New statistics interface" — **resets to 0 on firmware upgrade that adds this register range**, does not inherit history |
| 30272 | PV total daily generation | U32 | 100 | kWh | Added V2.8 |
| 30274 | PV total generation of previous day | U32 | 100 | kWh | Added V2.8 |
| 30276 | [Grid code] Rated Frequency | U16 | 100 | Hz | Added V2.8 |
| 30277 | [Grid code] Rated Voltage | U32 | 100 | V | Added V2.8 |
| 30280/30281 | Merged Alarm6/Alarm7 | U16 | N/A | N/A | Added V2.8; may 0x02-exception on older firmware |
| 30282 | General load power | S32 | 1000 | kW | Added V2.8 |
| 30284 | Total load power | S32 | 1000 | kW | Added V2.8 |
| 30286 | [ESS] Average cell temperature | S16 | 10 | °C | Added V2.9 |

Full table (SOC limits, per-phase detail, all 24 smart loads, full cumulative-energy list)
is in protocol §5.1 — reproduce directly from the PDF for anything not listed above.

---

## 5. Inverter-level read registers (function code 0x03, per-inverter slave ID 1–246)

Table 5‑3 "Hybrid inverter running information register definition". Selected registers of
interest (full PV string 1–16 voltage/current list and phase voltage/current omitted for
brevity — same pattern repeats):

| Addr | Name | Type | Gain | Unit | Comment |
|---|---|---|---|---|---|
| 30500 | Model type | STRING(15) | N/A | N/A | |
| 30515 | Serial number | STRING(10) | N/A | N/A | |
| 30525 | Machine firmware version | STRING(15) | N/A | N/A | |
| 30540 | Rated active power | U32 | 1000 | kW | (the worked-example register, §2 above) |
| 30548 | Rated battery capacity | U32 | 100 | kWh | |
| 30566/30568 | [ESS] Daily/Accumulated charge energy | U32/U64 | 100 | kWh | |
| 30572/30574 | [ESS] Daily/Accumulated discharge energy | U32/U64 | 100 | kWh | |
| 30578 | Running state | U16 | N/A | N/A | See §7 (Appendix 1) |
| 30587/30589 | Active/Reactive power | S32 | 1000 | kW/kVar | Per-inverter |
| 30591/30593 | [ESS] Max battery charge/discharge power | U32 | 1000 | kW | |
| 30601 | [ESS] Battery SOC | U16 | 10 | % | Per-inverter (vs plant-level 30014) |
| 30602 | [ESS] Battery SOH | U16 | 10 | % | |
| 30603 | [ESS] Average cell temperature | S16 | 10 | °C | |
| 30604 | [ESS] Average cell voltage | U16 | 1000 | V | |
| 30605–30609 | Alarm1–5 | U16 ×5 | N/A | N/A | Per-inverter alarm bitfields |
| 31000 | Rated grid voltage | U16 | 10 | V | |
| 31002 | Grid frequency | U16 | 100 | Hz | |
| 31003 | [PCS] Internal temperature | S16 | 10 | °C | |
| 31004 | Output type | U16 | N/A | N/A | 0: L/N; 1: L1/L2/L3; 2: L1/L2/L3/N; 3: L1/L2/N |
| 31005–31023 | Line/phase voltage & current, power factor | U32/S32 | 100 | V/A | |
| 31024–31026 | PACK count / PV string count / MPPT count | U16 | 1 | N/A | Use 31025 (PV string count) to know how many PV1..PV16 voltage/current registers are valid |
| 31027–31065 | PV1–PV16 voltage/current | S16 | 10/100 | V/A | |
| 31500–31525 | [DC Charger] running info (voltage, current, power, SOC, capacity, duration) | mixed | mixed | mixed | Only SigenStor / Sigen Hybrid |

---

## 6. Remote EMS control registers (writes) — function code 0x04/0x06/0x10, slave 247 or 0

This is the block you need to implement automated battery dispatch. All addresses below
are plant-level holding registers (Table 5‑2 in V2.9, split into §5.2.1–5.2.4; the same
registers appear as a single flat table 5‑2 in V2.7 — addresses are identical across both
versions).

### 6.1 Turning on remote control

| Addr | Name | Type | Gain | Unit | R/W | Comment |
|---|---|---|---|---|---|---|
| **40029** | **Remote EMS enable** | U16 | N/A | N/A | RW | **0: disabled; 1: enabled.** When enabled, plant EMS work mode (30003) switches to 7 ("Remote EMS mode"). |
| **40031** | **Remote EMS control mode** | U16 | N/A | N/A | RW | See enum table §6.2 below |

### 6.2 Remote EMS control mode enum (register 40031) — Appendix 6

| Value | Mode | Notes |
|---|---|---|
| 0x00 | **PCS remote control** | Enables the fixed/percentage power-dispatch registers below (40001 etc.) |
| 0x01 | Standby | |
| 0x02 | **Maximum self-consumption** | Use this to hand control back to "normal" self-consumption behavior while still in remote-EMS mode |
| 0x03 | Command charging (consume grid power first) | Charge limit register 40032 takes effect in modes 0x03/0x04 |
| 0x04 | Command charging (consume PV power first) | ″ |
| 0x05 | Command discharging (output from PV first) | Discharge limit register 40034 takes effect in modes 0x05/0x06 |
| 0x06 | Command discharging (output from ESS first) | ″ |
| 0x07 | Reserved | Added V2.9 (previously undefined) |
| 0x08 | **V2G** (Vehicle to Grid) | Added V2.9 |

### 6.3 Charge/discharge limits and SOC bounds

| Addr | Name | Type | Gain | Unit | R/W | Comment |
|---|---|---|---|---|---|---|
| 40032 | **ESS max charging limit** | U32 | 1000 | kW | RW | Range [0, rated ESS charging power]. Effective when 40031 = 3 or 4 |
| 40034 | **ESS max discharging limit** | U32 | 1000 | kW | RW | Range [0, rated ESS discharging power]. Effective when 40031 = 5 or 6 |
| 40036 | PV max power limit | U32 | 1000 | kW | RW | Effective when 40031 ∈ {3,4,5,6} |
| 40038/40040 | [Grid Point] Max export/import limitation | U32 | 1000 | kW | RW | Requires a grid sensor; takes effect globally regardless of EMS mode |
| 40042/40044 | PCS maximum export/import limitation | U32 | 1000 | kW | RW | 0xFFFFFFFF = register not active; takes effect globally |
| **40046** | **[ESS] Backup SOC** | U16 | 10 | % | RW | Range [0, 100.0] — minimum reserve SOC |
| **40047** | **[ESS] Charge Cut-Off SOC** | U16 | 10 | % | RW | Range [0, 100.0] |
| **40048** | **[ESS] Discharge Cut-Off SOC** | U16 | 10 | % | RW | Range [0, 100.0] |

### 6.4 Fixed/percentage power-dispatch registers (mode 0x00 / "PCS remote control" only)

**Both conditions must hold for these to take effect** (explicit in the V2.9 doc, §5.2.2):
(a) register 40029 (Remote EMS enable) = 1, **and** (b) register 40031 (Remote EMS control
mode) = 0. These registers only control PCS power — independent of loads and grid sensors.

| Addr | Name | Type | Gain | Unit | Comment |
|---|---|---|---|---|---|
| 40000 | Start/Stop | U16 (WO) | N/A | N/A | 0: Stop; 1: Start |
| 40001 | Active power fixed adjustment target value | S32 | 1000 | kW | (the worked-example register, §2 above) |
| 40003 | Reactive power fixed adjustment target value | S32 | 1000 | kVar | Range [-60×base, 60×base]. Takes effect globally regardless of EMS mode |
| 40005 | Active power percentage adjustment target value | S16 | 100 | % | Range [-100, 100] |
| 40006 | Q/S adjustment target value | S16 | 100 | % | Range [-60, 60]. Global |
| 40007 | Power factor adjustment target value | S16 | 1000 | N/A | Range [-1,-0.8] ∪ [0.8,1]. Requires grid sensor. Global |
| 40008–40025 | Per-phase (A/B/C) active/reactive fixed & percentage adjustment | S32/S16 | 1000/100 | kW/kVar/% | Only valid when output type (31004) is L1/L2/L3/N |
| 40030 | Independent phase power control enable | U16 | N/A | N/A | 0: disabled; 1: enabled — required to make the per-phase registers above take effect |

### 6.5 Handing control back to the inverter's own logic

Two options, in increasing order of "how much you give up":

1. **Stay in remote EMS, switch behavior**: write `40031 = 0x02` (Maximum
   self-consumption). Remote EMS stays enabled (40029 = 1, EMS work mode 30003 still reads
   7), but the inverter's own self-consumption algorithm runs instead of your fixed
   setpoints.
2. **Fully disable remote control**: write `40029 = 0`. Community reports (not in the
   official PDF — see quirks below) indicate this **always reverts plant EMS work mode
   (30003) to "Max self consumption" (mode 0)**, regardless of what mode (TOU, AI Mode,
   etc.) was active before remote EMS was ever enabled. If you need to restore a specific
   prior mode (e.g. TOU), you must re-select it explicitly through the mySigen app or find
   an equivalent write register for it (not documented in the Modbus protocol — EMS work
   mode 30003 is **read-only**; there is no write register to directly set it to TOU/AI
   Mode/Full-Feed-in over Modbus. Those modes appear to be app-only settings, while Modbus
   remote EMS is a separate, parallel control channel).

---

## 7. Running state / alarm enums (Appendix 1, brief)

Plant running state (30051) and per-inverter running state (30578) share the same enum:

| State | Value |
|---|---|
| Standby | 0x00 |
| Running | 0x01 |
| Fault | 0x02 |
| Shutdown | 0x03 |
| Environmental Abnormality | 0x07 (added V2.7) |

Alarm registers (General/Merged Alarm 1–7, per-inverter Alarm 1–5) are bitfields — decode
per Appendices 2–13 of the official PDF (PCS alarm codes 1000s, ESS alarm codes 2000s,
Gateway alarm codes 3000s, AC/DC-Charger alarm codes 5000s/5100s, Plant alarms). Not
reproduced in full here — pull directly from the PDF appendix tables if you need
human-readable alarm decoding; they're extensive (dozens of individual bit flags) and
rarely relevant to a basic dispatch client.

---

## 8. Heartbeat / watchdog for Remote EMS — **UNVERIFIED, read carefully**

**The official Sigenergy Modbus Protocol document (both V2.7 and V2.9) does not define any
heartbeat or watchdog register, and does not document any automatic timeout-based fallback
if a Modbus master stops writing to the system.** Section 4.2 "Interaction timeout" only
discusses a minimum 1000 ms polling interval between unicast requests — it is guidance for
avoiding overlapping requests, not a supervisory/failsafe mechanism.

Community evidence is mixed and inconclusive:

- A feature request on the `TypQxQ/Sigenergy-Local-Modbus` GitHub repo (Discussion #287,
  "Modbus command hold function") asked for the ability to auto-revert control after a
  fixed duration (e.g. 6 hours). The integration's maintainer replied: *"No. I did request
  this but not there yet."* — as of that discussion, no native timeout/hold feature existed.
- Separately, users on the Home Assistant community forum reported the plant's EMS work
  mode spontaneously switching to mode 7 ("Remote EMS mode") when Home Assistant's Modbus
  polling was interrupted (e.g. router reboot) — the *opposite* of a safe fallback to
  self-consumption. The integration maintainer's own explanation was that the *integration*
  (not the inverter) "guesses" a state when it cannot read the current one, i.e. this looks
  like a client-side artifact rather than inverter-side watchdog behavior.
- Community sources also state that **explicitly writing `40029 = 0`** (disabling remote
  EMS) causes the plant to revert to "Self consumption" — but this is a deliberate write by
  the host, not an autonomous timeout.

**Net conclusion: do not assume the inverter has any built-in fail-safe if your controller
crashes or loses network connectivity while holding the battery in a forced
charge/discharge command.** Build your own watchdog in the client application instead:
periodically re-affirm the setpoint (e.g. every 30–60 s, well inside the 1000 ms minimum
request period), and have a supervisory process that explicitly writes `40031 = 0x02`
(self-consumption) or `40029 = 0` (disable remote EMS) if your control loop stalls,
rather than trusting the hardware to do this for you. Confirm this behavior against your
actual hardware before relying on it in production — this is the single most important
open question flagged by this research.

---

## 9. Other quirks worth knowing before implementing

- **Protocol version drift is fast and real.** Between V2.7 (2025‑05) and V2.9 (2026‑05)
  Sigenergy added: grid-code (LVRT/HVRT/frequency ride-through) registers 40051–40068, PCC
  power-factor registers 40157/40158, a Grid Power Loss Lockout Alarm Clear register 40159,
  an entire ESS Preheating scheduling block (50000–50183, 30 time-of-use slots for battery
  preheating — Sigen PV M1‑HYA/HYB series only), DC-charger max charge/discharge limit
  registers (41002/41004), PSS (commercial substation) and PID (potential-induced
  degradation mitigation) device sections, a V2G control mode, and renamed/reorganized
  several section headers. **Re-check the latest PDF before shipping**, especially if your
  target hardware is a Sigen PV M1‑HYA/HYB (preheating) or has an AC/DC EV charger attached.
- **Values in the "Available max/min ... power/capacity" family only count running
  inverters.** If an inverter is in Standby/Fault/Shutdown, its capacity contribution drops
  out of these aggregates — don't be surprised by a plant-level max dropping when one unit
  in a multi-inverter system faults out.
- **The new cumulative-energy statistics registers (30196–30268, "New statistics
  interface") reset to zero on the firmware upgrade that introduces them** and do not
  inherit prior history — don't treat a sudden drop to 0 in these specific counters as a
  data error.
- **PV string count register (31025) must be checked before reading PV1..PV16
  voltage/current** — registers beyond your actual MPPT/string count either read as zero or
  may 0x02-exception, depending on firmware.
- **AC-Charger / DC-Charger / PSS / PID registers require their own distinct Modbus slave
  ID**, separate from the hybrid inverter's ID, even though physically part of the same
  plant. A DC Charger's data, however, is read *through* the hybrid inverter's own register
  range (31500+), not a separate slave ID — but AC-Chargers and PSS/PID units are separate
  slave IDs.
- **`Grid code` register 40501 (grid code selection) existed in earlier versions and was
  deleted in V2.7** — don't rely on register presence being stable release-to-release; add
  defensive handling for exception 0x02 (illegal data address) on any register your specific
  firmware doesn't recognize.

---

## Sources

- Sigenergy Modbus Protocol **V2.9** (2026‑05‑13), 65 pages — obtained via
  `https://raw.githubusercontent.com/TypQxQ/Sigenergy-Local-Modbus/main/Modbus_reference_documentation/Sigenergy%20Modbus%20Protocol%20EN_V2.9.pdf`
  (checked into the integration's own repo: https://github.com/TypQxQ/Sigenergy-Local-Modbus)
- Sigenergy Modbus Protocol **V2.7** (2025‑05‑23), 39 pages — official Sigenergy CDN:
  `https://www.sigenergy.com/uploads/us_download/1755488219226583.pdf` and mirrored at
  `https://github.com/Si-GCG/sigenergy_projects/blob/main/Modbus.Protocol.EN.-.SIGEN.pdf`
- `TypQxQ/Sigenergy-Local-Modbus` — Home Assistant integration and README (device ID
  conventions, port 502 default, "Known Limitations" notes on protocol version support):
  https://github.com/TypQxQ/Sigenergy-Local-Modbus
- `TypQxQ/Sigenergy-Local-Modbus` Discussion #287, "Modbus command hold function" (no
  native command-hold/timeout feature as of the discussion):
  https://github.com/TypQxQ/Sigenergy-Local-Modbus/discussions/287
- Home Assistant Community thread "Sig Energy System Integration" (anecdotal reports of EMS
  mode changing unexpectedly on communication loss):
  https://community.home-assistant.io/t/sig-energy-system-integration/760448
- Sigenergy "How do I enable Modbus TCP?" support article (Remote EMS Mode setup steps,
  Powerhouse Settings): https://support.sigenergy.com/problem-details?noticeId=1011
- `Rocket-Search/sigenergy-modbus` (independent open-source client, corroborating register
  usage): https://github.com/Rocket-Search/sigenergy-modbus
