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
5. Press **Step**, select X on the pendant, choose a small step, and turn the wheel. CNCjs and
   the EL400 should follow the simulated position. Without a pendant, use
   CNCjs's jog buttons or enter `$J=G91 G21 X5 F600` in its console.

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
where GRBL supports them. It starts in **MPG**, which adjusts feed override.
Press **Step** or **Continuous** before using the wheel to move an axis.

| Mode | Wheel behavior |
| --- | --- |
| MPG | Adjust feed override |
| Lead | Adjust spindle override; never jog |
| Step | Move the selected distance per detent; finish the requested move after the wheel stops |
| Continuous | Jog at the selected percentage of the axis maximum rate; cancel after 180 ms without wheel movement |

Leaving Lead returns to MPG. Step sizes are **0.001, 0.01, 0.1, 1, 5, and 10 mm**;
the 5/10 mm settings require explicit enablement in the pendant widget. These
replace the previous 10/50 mm mappings. The widget also configures step feed,
spindle speed increments, and custom macros. Settings are local to the browser
and CNCjs address.

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
after a reset. Its upstream Safe-Z and W-Home
macros assume machine Z **-5 mm**; Probe-Z assumes a **50 mm** downward search and
defaults to a **20 mm** plate. Check those settings against the machine before
using those buttons. The supported manual workflow here is three-axis GRBL;
the pendant's A/B/C selectors do not add axes to a three-axis controller.

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
the EL400 display after a jog. A virtual HID receiver captures the pendant's actual
LCD packets, including G20/G21 conversion and reconnect behavior.
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
