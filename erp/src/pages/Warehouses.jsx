import Placeholder from '../components/Placeholder.jsx';

export default function Warehouses() {
  return (
    <Placeholder
      title="Warehouses"
      purpose={
        'Where stock physically sits, and the movements between those '
        + 'places. Every other inventory screen currently treats stock as '
        + 'one pool, which is true today: the studio holds tiles in one '
        + 'location.'
      }
      open={[
        'Does a second location mean a separate stock figure per product, or one figure with a location breakdown?',
        'Is a transfer between locations one movement or a paired outward and inward in the ledger?',
        'While stock is in transit, which location owns it, and does the website still see it as available?',
        'Can a sales order draw from more than one location, or must it be fulfilled from one?',
      ]}
    />
  );
}
