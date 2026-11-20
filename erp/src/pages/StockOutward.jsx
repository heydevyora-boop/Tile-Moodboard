import MovementList from '../components/MovementList.jsx';

export default function StockOutward() {
  return (
    <MovementList
      dir="out"
      title="Outward"
      recordLabel="Record an issue"
      intro="Everything that left: sale dispatches, samples issued to the studio, breakages and downward adjustments. A sample and a breakage are counted here but never as sales."
    />
  );
}
