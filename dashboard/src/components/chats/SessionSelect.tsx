import { useTranslation } from 'react-i18next';
import type { Session } from '../../services/api';

interface SessionSelectProps {
  /** The select's DOM id, which its visible label points at. Unique per page. */
  id: string;
  sessions: Session[];
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
}

// Session picker shared by the Chats sidebar and the label board: the ready sessions, named with
// their phone. Styled by the host page's `.session-select-group` / `.session-selector` rules.
function SessionSelect({ id, sessions, selectedSessionId, onSelectSession }: SessionSelectProps) {
  const { t } = useTranslation();
  return (
    <div className="session-select-group">
      <label className="form-label" htmlFor={id}>
        {t('chats.sessionLabel')}
      </label>
      <select
        id={id}
        value={selectedSessionId}
        onChange={e => onSelectSession(e.target.value)}
        className="session-selector"
      >
        {sessions.map(s => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.phone || t('chats.noPhone')})
          </option>
        ))}
      </select>
    </div>
  );
}

export default SessionSelect;
