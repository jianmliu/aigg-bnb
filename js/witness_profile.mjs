import assert from 'node:assert/strict';
// The exact MEP certificate is an operator attestation about verified CSR data, not an on-chain proof of a global maximum.
export function maxInDegree(rows,synapses){
 assert(rows instanceof Uint32Array&&rows.length>=2,'CSR row offsets');
 assert.equal(rows[0],0,'CSR start');assert.equal(rows.at(-1),synapses,'CSR end');
 let max=0;for(let i=1;i<rows.length;i++){assert(rows[i]>=rows[i-1],'nonmonotonic CSR');max=Math.max(max,rows[i]-rows[i-1]);}
 assert(max<=16384,'row exceeds supported witness size');return max;
}
export function measuredProfile(node,st){return maxInDegree(node.k.u32(st.csr.rowStartPtr,st.hdr.neurons+1),st.hdr.synapses);}
