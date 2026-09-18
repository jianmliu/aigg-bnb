// The page's vocabulary: a panel, a labelled field, a button, a stat chip, a status pill. Everything visible is
// built from these five, which is what keeps five different concerns (a URL, an amount of BNB, a signature, a
// 28 MB download, a running node) looking like one instrument.

/** a numbered section of the flow -- the numbers are the order the node has to be brought up in */
export function Panel({ step, title, note, children }) {
  return (
    <section className="panel">
      <header>
        {step != null && <span className="step">{step}</span>}
        <h2>{title}</h2>
        {note && <span className="note">{note}</span>}
      </header>
      <div className="body">{children}</div>
    </section>
  );
}

export function Field({ label, htmlFor, className = "", children }) {
  return (
    <div className={`field ${className}`.trim()}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
    </div>
  );
}

export function Button({ tone, children, ...rest }) {
  return <button className="btn" data-tone={tone} {...rest}>{children}</button>;
}

/** a number that changes, with the word for what it is underneath it */
export function Chip({ k, v, tone, title }) {
  return (
    <div className="chip" data-tone={tone} title={title}>
      <span className="v">{v}</span>
      <span className="k">{k}</span>
    </div>
  );
}

export function Pill({ tone, children }) {
  return <span className="pill" data-tone={tone}><span className="dot" />{children}</span>;
}
