# CNCjs manual milling integration

Operate a CNC-converted mill with a WHB04B-6 handwheel and an EL400 digital readout.
CNCjs owns the machine connection; the pendant supplies jog commands and the DRO
displays the controller position. An optional GRBL simulator supports practice
without a machine on Windows and Linux.

Components:

- [CNCjs](https://github.com/cncjs/cncjs)
- [WHB04B-6 WebHID pendant](https://github.com/pedropaulovc/cncjs-pendant-whb04b-6)
- [EL400 DRO](https://github.com/pedropaulovc/el400)
- [Conversational programming widget](https://github.com/pedropaulovc/cncjs-conversational)
- [dechatter chatter-free cut finder](https://github.com/pedropaulovc/dechatter)

## Install

Install Git and Node.js **22.12 or newer** with npm. Chrome or Edge is required
for the pendant's WebHID connection. Setup installs project-local dependencies;
it does not need a global CNCjs install or administrator access.

On Windows, prerequisites can be installed from PowerShell:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.PowerShell -e
```

Reopen the terminal after installing them, then:

```powershell
git clone https://github.com/pedropaulovc/cncjs-whb04b6-el400-integration.git
cd cncjs-whb04b6-el400-integration
pwsh -File ./setup.ps1
```

On Linux, install Git with your distribution's package manager and install a
Node.js LTS release that meets the version requirement. Check `node --version`
and `npm --version`; older distribution packages may not meet the requirement.

```sh
git clone https://github.com/pedropaulovc/cncjs-whb04b6-el400-integration.git
cd cncjs-whb04b6-el400-integration
sh ./setup.sh
```

`node scripts/setup.mjs` also works directly on either platform. It installs the
locked CNCjs, pendant, and EL400 npm packages. It leaves sibling checkouts and
your existing `~/.cncrc` alone. Stop CNCjs with Ctrl+C before rerunning setup
after an update; Windows locks files used by the running server.

`npm run setup` uses the same installer. Child npm commands read their normal
project/user `.npmrc` script-approval policy; setup removes only npm lifecycle's
exported `npm_config_allow_scripts` copy, which npm rejects as an install-time
option. It does not disable install scripts, change approval files, or remove
other environment/authentication settings.

## Practice without a machine

```sh
npm start
```

1. Open **http://localhost:8000** in Chrome or Edge.
2. In CNCjs's Connection widget select **Grbl**, port **SIMULATOR**, and baud rate
   **115200**, then click **Open**.
3. In **Manage Widgets**, turn on **Custom Widget** and click **OK**. Use the
   widget's gear icon to set its title and URL, then enable it. Use **More options
   → Fork Widget** to create each further widget and change its title and URL.
   The DRO fits best using **More options → Enter Full Screen**.

   | Title | URL |
   | --- | --- |
   | WHB04B-6 pendant | `/whb04b/widget/index.html` |
   | EL400 DRO | `/el400/?source=cncjs` |
   | Conversational | `/conversational/` |
   | dechatter | `/dechatter/` |

   The conversational widget generates G-code for facing, side facing, squaring
   up stock, pockets and bolt circles. With a port open, its **Load in CNCjs**
   button replaces the program loaded in CNCjs, ready for the Visualizer and
   **Run**.

   The dechatter widget finds chatter-free spindle speeds, widths and depths of
   cut. It plans test cuts, loads them into CNCjs and listens to them through
   the computer's microphone, so the browser asks for microphone access. It
   takes a few seconds to start: it runs Python in the browser tab.

   EL400's **Enter fullscreen** control below the readout requests browser
   fullscreen on a click; **Exit fullscreen** or Esc leaves it. This differs
   from the CNCjs widget menu, which expands only within the workspace.
   Browser support or embedding policies can block fullscreen. If so, use
   **Open EL400 in new tab** and try again, or use the browser's fullscreen
   command. The link retains the current connection URL, which may contain a
   CNCjs token; treat it as a credential and do not share it. A tab opened from
   the widget may inherit its sandbox; if necessary, copy the link into an
   independent tab instead.

4. Plug in the pendant receiver and click **Connect pendant** inside its widget.
   Choose the WHB04B-6 device in the browser prompt. This permission needs an
   operator click; it cannot be granted by the setup script.
5. Select X on the pendant, choose a small step, and turn the wheel. It starts in **Step** mode. CNCjs and
   the EL400 should follow the simulated position. Without a pendant, use
   CNCjs's jog buttons or enter `$J=G91 G21 X5 F600` in its console.

The EL400's **ABS** and **INC** modes both track jogging. With a native GRBL
CNCjs controller, ABS shows the controller's work position (**WPos**). ABS
zero, preset and other datum edits request controller work-offset changes
using **G10**, without moving the machine; external offset or active work
coordinate changes update ABS. INC uses an independent local datum based on
machine position (**MPos**): INC datum edits never write controller offsets,
and external offset changes do not reset it. While disconnected, ABS remains
controller-owned and INC uses the last machine position rather than switching
to manual counters.

In CNCjs mode the controller's native **G20/G21** state also owns the EL400 unit
display. EL400's unit button requests G20 or G21; it changes the display only
after controller confirmation. Unit changes made in CNCjs or by a macro update
both widgets without being echoed back. Changing units does not move the machine
or reset the physical ABS/INC datum. Requests are rejected while disconnected or
busy. Standalone EL400 use keeps its local display-only unit toggle.

The pendant mount includes its entire `web` directory because the widget imports
the driver from its parent directory. Mounting only `web/widget` breaks that import.
CNCjs supplies its session token to embedded widgets; there is no secret to paste.
Keep the CNCjs tab open while using the pendant.

`npm run simulate` also starts simulation. Ctrl+C stops the server. Simulation
exposes only `SIMULATOR` and rejects attempts to open physical serial ports.
It uses CNCjs's actual serial transport interface and GRBL parser with an in-process
mock binding, so no virtual COM driver, `socat`, or administrator access is needed.

The simulator supports XYZ linear moves, standalone `G4 Pseconds` dwells, timed jogging, status queries, hold/resume,
jog cancel, reset, feed/rapid/spindle overrides, spindle and coolant state, homing to zero, G20/G21, G90/G91, and G54 work offsets through
`G10 L20 P1`. It does not model cutting, acceleration, limits, alarms, arcs, probing,
or firmware configuration writes. Unsupported G-code returns an
error. Positions reset on reconnection or restart. Use it to check the controls
and readout, not to validate a machining program.

## Pendant controls

The pendant follows [LinuxCNC's WHB04B-6 mappings](https://www.linuxcnc.org/docs/master/html/en/man/man1/xhc-whb04b-6.1.html)
where GRBL supports them. New widgets start in **Step**, so the wheel moves the
selected distance per detent. Reconnecting the receiver preserves the selected mode.

| Mode | Wheel behavior |
| --- | --- |
| MPG | Adjust feed override |
| Lead | Adjust spindle override; never jog |
| Step | Move the selected distance per detent; finish the requested move after the wheel stops |
| Continuous | Jog at the selected percentage of the axis maximum rate; cancel after 180 ms without wheel movement |

Leaving Lead returns to MPG. Step selector values are **0.001, 0.01, 0.1, 1, 5,
and 10** in the controller's current program units: **mm in G21, inches in G20**.
For example, the 0.1 selector moves 0.1 mm in G21 and 0.1 in (2.54 mm) in G20.
The widget shows the active units; GRBL's `$13` position-report setting does not
choose Step distances. EL400 follows the same confirmed program units in CNCjs
mode. The 5/10 settings require explicit enablement in the pendant widget,
including in inch mode. These replace the previous 10/50 mappings.

Step moves use the selected axis's GRBL maximum rate (`$110`/`$111`/`$112`),
independently of program Feed %, following LinuxCNC's default position-mode
jog-wheel behavior. Jog commands express distance and feed in the current G20/G21
units without changing the program's modal units. Continuous retains its selected
percentage of the physical axis maximum rate in either unit mode.
**Step moves can run at full axis speed:** check the configured machine limits
and clearance before jogging, especially when selecting inch steps.
The widget configures spindle speed increments and custom macros, but has no
separate Step feed setting. Settings are local to the browser and CNCjs address.
Probe-Z uses CNCjs's **Tool** widget **Touch Plate Height**, not a pendant-local
thickness setting. Safe-Z and W-Home share **Tool Change Position Z** from that
same widget. These server settings are read afresh for every button press; there
is no separate pendant clearance or probe-thickness setting.

Normal jogging uses CNCjs's existing position/state updates without adding a
stream of `client> ?` queries. Ambiguous completion and cancellation can still
request explicit status confirmations; a missing reply never counts as stopped.

Turning the rate selector in MPG or Continuous also sets the program feed
override to that percentage. GRBL's minimum override is 10%, so its 2% and 5%
positions use 10% for program feed override; Continuous jog speed still uses
the printed percentage. The first input report does not change the override.

Feed +/- and Spindle +/- adjust overrides. **Fn + Spindle +/-** changes the
programmed RPM; **Fn + S on/off** selects the next spindle direction while
stopped. **Fn + Continuous/Step** toggles flood/mist coolant. GRBL firmware must
support mist for that function. **Start/Pause** starts, pauses, or resumes the
CNCjs program; **Stop** cancels it. The parent pendant repository documents the
[full mapping and configuration](https://github.com/pedropaulovc/cncjs-pendant-whb04b-6#readme).

Open the top-level **Macro buttons** panel, choose an unused numbered Macro/Fn
combination, and click **Add macro button**. New mappings are **Disabled** and
cannot execute until assigned. Assign custom multiline G-code or a saved CNCjs
macro; valid settings save automatically, including assignment changes and
removal. Only configured mappings are listed, and their identifiers survive a
reload. Linked macros use the current CNCjs definition on each press.
Visualizer-bound expressions and CNCjs's optional Run Macro event hooks require
the native Macro widget.

The **Mode** information control provides help on hover, click, or keyboard
focus. The read-only default-button reference is separate from editable macro
assignments. Healthy token, socket, and port badges stay hidden; pendant readiness
and connection faults remain visible. **Reconnect** is inside **Diagnostics**.

## Connect a physical GRBL machine

```sh
npm run machine
```

Open **http://localhost:8001**, select the machine's serial port with controller
**Grbl** and its configured baud rate, then click **Open**. Add the same two widget
URLs and authorize the pendant. Machine mode uses the native serial driver and a
separate CNCjs configuration and browser origin from simulation. Starting it does
not select or open a machine port automatically.

On Windows, install the controller manufacturer's USB serial driver if its COM
port is missing. On Linux, the operator needs serial-port and hidraw access. For
Debian/Ubuntu installations, serial access usually uses the `dialout` group:

```sh
sudo usermod -aG dialout "$USER"
```

Log out and back in after changing groups. For the pendant receiver, install this
udev rule as `/etc/udev/rules.d/70-whb04b.rules`:

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="10ce", ATTRS{idProduct}=="eb93", TAG+="uaccess"
```

Reload with `sudo udevadm control --reload-rules`, then unplug and reconnect the
receiver. The rule grants access to the active local desktop session. Remote or
headless sessions need permissions appropriate to their login setup.

Start with a small jog and confirm axis direction, step size, work zero, and stop
behavior with the spindle off and the tool clear. The pendant's software Reset
and Stop do not replace a wired emergency stop. Stop cancels jogging and clears
queued CNCjs commands. For a running program, it requests hold and waits for GRBL
to report that motion has stopped before resetting the controller. Pendant motion
commands stay blocked until the stop is confirmed. A running or paused program is
canceled even during a dwell, when GRBL reports Idle. With no active program,
Stop at Idle or during jogging does not switch off the spindle. Follow the controller's unlock/homing procedure
after a reset. Before using Safe-Z, W-Home, or Probe-Z, configure CNCjs's **Tool**
widget. **Tool Change Position Z** is a machine-coordinate Z in millimetres;
Safe-Z retracts there, and W-Home retracts there before moving to G54 work X0 Y0,
leaving Z at clearance (it does not move to work Z0). **Touch Plate Height** is
the probe plate thickness in millimetres; Probe-Z retains its **50 mm** downward
search and **3 mm** retract. CNCjs defaults an unset Tool Change Position Z to
**0 mm** and an unset Touch Plate Height to **0 mm**; neither default is a safety
guarantee. Set and check both against the actual machine, tool, and plate.
Present invalid settings or failed reads block the action rather than falling
back to an old pendant value. The supported manual workflow here is three-axis
GRBL; the pendant's A/B/C selectors do not add axes to a three-axis controller.

FluidNC controllers also work with CNCjs's **Grbl** controller type. FluidNC's `$$`
omits the report units and axis maximum rates the pendant needs. After joining an
idle controller, the widget sends `$I` and then reads `$/report_inches`,
`$/axes/{x,y,z}/steps_per_mm`, and `$/axes/{x,y,z}/max_rate_mm_per_min`. These
read-only queries appear in the CNCjs console. Fn spindle-speed changes stay
unavailable on FluidNC. The EL400 likewise sends `$I` and reads `$/report_inches`
when `$$` omits `$13`. When a status report arrives without WCO (FluidNC sends it
in about one report in ten), the EL400 reads its work offsets with `$#`.

The EL400 receives controller coordinates, not independent scale measurements.
It therefore cannot detect missed steps, backlash, or a stalled axis. Its local
datum/display features can differ from CNCjs's G54 work coordinates; confirm the
coordinate system before returning to a programmed move.

## Configuration and troubleshooting

```sh
# Use a different HTTP port
npm run simulate -- --port 8080
npm run machine -- --port 8081
```

The server binds to `127.0.0.1`. Open it on the same computer using `localhost` so
WebHID has a secure context. Remote pendant operation requires HTTPS and suitable
browser permissions, which this launcher does not configure.

- **DRO disconnected:** open the GRBL port first, then enable the custom widget.
  Use the embedded URL with `source=cncjs`; a plain `/el400/` runs its standalone
  simulator instead.
- **Pendant unavailable:** use Chrome/Edge, a localhost URL, and the receiver's
  USB connection. Check Linux hidraw permissions and close other apps using it.
- **Install failure:** read the command printed before the failure. Setup needs
  access to the npm registry and reinstalls dependencies from the lockfile. If npm
  reports `EBUSY`, stop any CNCjs process running from this checkout and rerun.
- **Port already in use:** stop the other server or supply `--port`.

Runtime files live under `.runtime/`: `install.json` records widget paths and
the pendant, EL400, conversational and dechatter npm versions. `cncjs-simulator.json` and
`cncjs-machine.json` hold separate server settings. These files can contain
credentials and are excluded from Git.
To rebuild from scratch, stop the server, save any wanted runtime settings and
local changes in old checkouts, remove `.runtime` and `node_modules` from this
checkout, and rerun setup. Browser widget layouts and EL400 preferences live in
browser storage and are separate. Old `.runtime/pendant` and `.runtime/el400`
checkouts are no longer used; setup leaves them untouched. You may remove them
once any local changes are saved.

CNCjs 1.11.5 brings legacy dependencies with npm audit findings. This integration
pins that dependency tree and listens locally. Review upstream updates before
changing the lockfile; an automatic `npm audit fix --force` can change the runtime
and Socket.IO compatibility.

## Development

See [DEVELOPING.md](DEVELOPING.md) for tests and package updates.

## License

MIT. Each upstream component retains its own license.
