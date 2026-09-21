import { createRoot } from "react-dom/client";
import App from "./ui/App.jsx";
import * as C from "./core/controller.js";
import * as F from "./core/flies.js";
import "./styles/app.css";

// The handles the end-to-end test drives the page through, and the ones worth having in a console: `app.state` is
// the live object the controller mutates, and `appActions` are the raw actions -- unwrapped, so a caller sees the
// rejection instead of a line in the log.
window.app = { state: C.state, log: C.log };
window.appActions = {
  loadDeployment: C.loadDeployment, connect: C.connect, bond: C.bond, delegate: C.delegate,
  loadModel: C.loadModel, startNode: C.startNode, refreshBond: C.refreshBond, loop: C.loop, postTask: C.postTask,
  setActive: C.setActive, host: C.host, replayFamilyTask: C.replayFamilyTask,
  selectBatteryRoute: F.selectBatteryRoute, quoteBattery: F.quoteBattery, loadBattery: F.loadBattery, fundBattery: F.fundBattery, refundBattery: F.refundBattery, loadTerms: F.loadTerms, loadFlies: F.loadFlies, breed: F.breed, hatch: F.hatch, rearm: F.rearm, loadGenesis: F.loadGenesis, adopt: F.adopt, settle: F.settle, withdraw: F.withdraw,
};

createRoot(document.getElementById("root")).render(<App />);
