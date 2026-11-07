// Runs the week-long autoscaling simulations off the main thread.
import { evaluate } from "./capacity.js";

self.onmessage = (e) => {
  const { id, cfg } = e.data;
  const R = evaluate(cfg, { skipSpotTable: true });
  self.postMessage({ id, hpa: R.hpa });
};
