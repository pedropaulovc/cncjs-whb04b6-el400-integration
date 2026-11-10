# Development

```sh
npm test
npx playwright install chromium
npm run test:integration
```

Unit tests exercise the GRBL protocol and simulated serial isolation. The
integration test starts the real CNCjs server, checks widget assets, opens the
simulator, exercises the pendant's session after G20, and checks machine/work
coordinates through Socket.IO. It also boots both widgets in Chromium and checks
controller-owned EL400 ABS and independent local INC after jogging and
work-offset changes, including ABS zero/presets and INC zero/preset/half without
controller writes. A virtual HID receiver exercises first-report Step jogging and
captures the pendant's actual LCD
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
physical WPos/datum preservation across unit conversion (including an ABS preset
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
and physical motion still require the operator checks in the README.

Publish pendant, EL400, conversational or dechatter widget changes as an npm
release from the respective repository before updating this integration. Install
the chosen release with `npm install --save-exact cncjs-pendant-whb04b-6@<version>`,
`npm install --save-exact el400@<version>`,
`npm install --save-exact cncjs-conversational@<version>` or
`npm install --save-exact dechatter@<version>`, commit both package files, then rerun
setup and the tests above. Setup serves each installed package's `web` directory;
it does not read widget code from sibling checkouts.
