import { Icon } from '../Icon/Icon'
import './TitleBar.css'
export function TitleBar() {
  return <header className="title-bar"><span className="title-bar-caption">DUPROVE</span><div className="window-actions">
    <button aria-label="Свернуть окно" onClick={() => window.duprove?.windowAction('minimize')}><Icon name="minus" size={17}/></button>
    <button aria-label="Развернуть или восстановить окно" onClick={() => window.duprove?.windowAction('maximize')}><Icon name="maximize" size={16}/></button>
    <button className="window-close" aria-label="Закрыть окно" onClick={() => window.duprove?.windowAction('close')}><Icon name="close" size={18}/></button>
  </div></header>
}
