# CNCjs manual milling integration

Operate a CNC-converted mill with a WHB04B-6 handwheel and an EL400 digital readout.
CNCjs owns the machine connection; the pendant supplies jog commands and the DRO
displays the controller position. An optional GRBL simulator supports practice
without a machine on Windows and Linux.

Components:

- [CNCjs](https://github.com/cncjs/cncjs)
- [WHB04B-6 WebHID pendant](https://github.com/pedropaulovc/cncjs-pendant-whb04b-6)
- [EL400 DRO](https://github.com/pedropaulovc/el400)

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
locked CNCjs and pendant npm packages, clones the pinned EL400 source into `.runtime`,
and builds EL400. It leaves sibling checkouts and your existing `~/.cncrc` alone.
Stop CNCjs with Ctrl+C before rerunning setup after an update; Windows locks files
used by the running server. Setup stops if its managed
EL400 checkout contains local changes so they can be saved first.

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
   → Fork Widget** to create the second widget and change its title and URL.
   The DRO fits best using **More options → Enter Full Screen**.

   | Title | URL |
   | --- | --- |
   | WHB04B-6 pendant | `/whb04b/widget/index.html` |
   | EL400 DRO | `/el400/?source=cncjs` |

4. Plug in the pendant receiver and click **Connect pendant** inside its widget.
   Choose the WHB04B-6 device in the browser prompt. This permission needs an
   operator click; it cannot be granted by the setup script.
5. Select X on the pendant, choose a small step, and turn the wheel. It starts in **Step** mode. CNCjs and
   the EL400 should follow the simulated position. Without a pendant, use
   CNCjs's jog buttons or enter `$J=G91 G21 X5 F600` in its console.

The EL400's **ABS** and **INC** modes both track jogging. In CNCjs mode, ABS
shows machine position (**MPos**) and INC shows the controller's work position
(**WPos**). **Zero X/Y/Z** or an INC preset requests a **G10** work-offset
change, not motion: MPos stays unchanged and CNCjs and EL400 show the confirmed
WPos. External work-offset changes also update INC. Standalone EL400 use retains
its independent incremental datum.

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
unavailable on FluidNC.

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
- **Build/install failure:** read the command printed before the failure. Setup
  needs access to GitHub and the npm registry. Rerunning setup preserves clean
  pinned source clones and reinstalls dependencies from their lockfiles. If npm
  reports `EBUSY`, stop any CNCjs process running from this checkout and rerun.
- **Port already in use:** stop the other server or supply `--port`.

Runtime files live under `.runtime/`: `install.json` records widget paths and
the pendant npm version and EL400 revision. `cncjs-simulator.json` and
`cncjs-machine.json` hold separate server
settings. These files can contain credentials and are excluded from Git.
To rebuild from scratch, stop the server, save any wanted runtime settings, remove
`.runtime` and `node_modules` from this checkout, and rerun setup. Browser widget
layouts and EL400 preferences live in browser storage and are separate. An old
`.runtime/pendant` checkout is no longer used after setup; you may remove it once
any local changes are saved.

CNCjs 1.11.5 brings legacy dependencies with npm audit findings. This integration
pins that dependency tree and listens locally. Review upstream updates before
changing the lockfile; an automatic `npm audit fix --force` can change the runtime
and Socket.IO compatibility.

## Development

```sh
npm test
npx playwright install chromium
npm run test:integration
```

Unit tests exercise the GRBL protocol and simulated serial isolation. The
integration test starts the real CNCjs server, checks widget assets, opens the
simulator, exercises the pendant's session after G20, and checks machine/work
coordinates through Socket.IO. It also boots both widgets in Chromium and checks
the EL400 ABS and controller-owned INC displays after jogging and work-offset changes. A virtual HID
receiver exercises first-report Step jogging and captures the pendant's actual LCD
packets, including G20/G21 conversion and reconnect behavior. The same receiver
checks positive and negative 0.1-inch (2.54 mm) Step moves, then 0.1-mm moves after
switching to G21. It verifies unit-aware readouts, axis-maximum wire feed despite
50% program Feed %, and unchanged parser modal units after jogging, with `$13=0`.
It also checks that queued +7/−1 mm jogs complete without extra status queries.
The shared server/browser fixture runs separate motion-safety, controls, and
shared-Tool-setting scenarios, each with its own 90-second deadline. The shared
setting scenario presses physical Safe-Z/W-Home inputs against real CNCjs,
checks metric machine clearance after a G20 start, verifies a changed setting
on the next press, and cancels a pending read with Stop. The controls scenario checks
EL400-to-controller and external-controller G20/G21 changes without echo,
physical WPos/datum preservation across unit conversion (including a preset
queued behind a conflicting G21 during an Idle-reporting dwell), rejected busy/disconnected
unit requests, disabled mappings and autosaved assignment/removal across reloads,
live macro disabling in two widgets sharing browser storage, Mode help
interaction, and healthy/fault diagnostics visibility. The pendant has no local
probe-thickness field or persisted thickness setting.
Widget startup waits for both iframe documents (including their module scripts)
to finish loading before starting the unchanged socket-join and HID assertions.
Startup failures report iframe readiness, boot/socket state, widget logs, and
CNCjs output; browser exceptions and failed HTTP requests are printed as they occur.
Browser tests run headlessly. Set `PW_CHANNEL=msedge`
to use Edge locally instead of Playwright's bundled Chromium.
CI runs setup and these tests on Windows and Linux. Hardware WebHID permission
and physical motion still require the operator checks above.

Publish pendant changes as an npm release from the parent repository before
updating this integration. Install the chosen release with
`npm install --save-exact cncjs-pendant-whb04b-6@<version>`, commit both package
files, then rerun setup and the tests above. Setup serves the installed package's
`web` directory; it does not read pendant code from a sibling checkout.

## License

MIT. Each upstream component retains its own license.
