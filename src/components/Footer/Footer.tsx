import { repositoryUrl } from '../../config/project'
import './Footer.css'

export default function Footer() {
  return (
    <footer className="footer flex items-center justify-between gap-4">
      <a href="#home" className="footer__brand">
        Duprove
      </a>
      <a href={`${repositoryUrl}/blob/HEAD/LICENSE`} target="_blank" rel="noreferrer">
        Открытый исходный код · GPL-3.0
      </a>
    </footer>
  )
}
