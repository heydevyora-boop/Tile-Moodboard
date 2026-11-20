/* A status, with its own word beside its colour.
   Colour alone would leave Out of Stock and Low Stock
   indistinguishable to a colour-blind reader and in a printed
   stock report, so the label is never optional. */
export default function StatusPill({ tone = 'info', children, title }) {
  return <span className={'pill pill-' + tone} title={title}>{children}</span>;
}
