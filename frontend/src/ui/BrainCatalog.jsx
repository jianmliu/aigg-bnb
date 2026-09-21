import { useState } from 'react';
import * as C from '../core/controller.js';
import { BrainCard } from './BrainCard.jsx';
import { Button } from './primitives.jsx';

// The controller retains the model catalog and hosting selections; this component mounts only one visible page.
export function BrainCatalog({ visible, listing = false, steps }) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(1);
  if (!visible) return null;
  const s = C.state, prefix = listing ? 'brains' : 'host';
  const query = search.trim().toLowerCase();
  const matches = s.meps.filter(m => (scope !== 'selected' || s.hosted.has(m.mepId)) &&
    (!query || `${m.name || ''} ${m.mepId} ${m.token || ''}`.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(matches.length / 12)), current = Math.min(page, pages);
  const shown = matches.slice((current - 1) * 12, current * 12);
  return <div id={`${prefix}Catalog`}>
    <div className="catalog-controls">
      <label htmlFor={`${prefix}Search`}>Find a brain
        <input id={`${prefix}Search`} type="search" value={search} placeholder="Name, fly number or MEP ID"
          onChange={e => { setSearch(e.target.value); setPage(1); }} />
      </label>
      {!listing && <label htmlFor="hostScope">Show
        <select id="hostScope" value={scope} onChange={e => { setScope(e.target.value); setPage(1); }}>
          <option value="all">All available brains</option><option value="selected">Selected for hosting ({s.hosted.size})</option>
        </select>
      </label>}
    </div>
    {!matches.length && <p className="hint">{scope === 'selected' ? 'No selected brains match this search.' : 'No brains match this search.'}</p>}
    <div className={listing ? 'listings' : 'brains'}>
      {shown.map((m, i) => <BrainCard key={m.mepId} listing={listing} index={i} mep={m}
        active={m.mepId === s.active} hosted={s.hosted.has(m.mepId)} steps={steps}
        onSelect={() => C.setActive(m.mepId)} onHost={v => C.host(m.mepId, v)} />)}
    </div>
    {matches.length > 12 && <div className="row tight center flies-paging">
      <Button id={`${prefix}Prev`} disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</Button>
      <span>Page {current} of {pages} · {matches.length} brains</span>
      <Button id={`${prefix}Next`} disabled={current === pages} onClick={() => setPage(current + 1)}>Next</Button>
    </div>}
  </div>;
}
