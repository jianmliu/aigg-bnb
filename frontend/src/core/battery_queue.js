/** What the battery queue panel is entitled to say about an individual fly.
 *
 *  "not funded" is a per-fly fact: this one has no job, and the owner can start one. It is only a fact when there is
 *  somewhere to start it. On a deployment with no battery budget configured -- which is every deployment that has not
 *  deployed that contract, including BSC testnet today -- `jobs` is empty for the same reason it is empty before the
 *  first read returns: not because two hundred flies are each unfunded, but because the queue does not exist here.
 *  Saying "not funded" two hundred times then reads as two hundred things the owner could go and do, next to one line
 *  admitting none of them can be done. So the panel asks this first.
 *
 *    "ready"       the queue is configured; a fly with no job really is unfunded
 *    "unavailable" no battery budget on this deployment, or the read failed -- say why, and say nothing per fly
 *    "checking"    the first read has not come back yet
 */
export const batteryQueue = (battery) =>
  battery?.address ? "ready" : battery?.loading ? "checking" : battery?.error ? "unavailable" : "checking";
