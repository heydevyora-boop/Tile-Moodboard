import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="panel">
      <div className="empty">
        <h3>No such screen</h3>
        <p>
          That address does not match any module in this build.
          {' '}<Link to="/">Back to the dashboard</Link>.
        </p>
      </div>
    </div>
  );
}
