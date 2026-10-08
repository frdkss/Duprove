import { ArrowUpRight } from 'lucide-react'
import { repositoryUrl } from '../../config/project'
import './Header.css'

export default function Header() {
  return (
    <header className="header flex items-center justify-between">
      <a className="header__brand" href="#home" aria-label="Duprove — в начало">
        Duprove
      </a>
      <nav className="header__nav flex items-center" aria-label="Основная навигация">
        <a className="header__github" href={repositoryUrl} target="_blank" rel="noreferrer">
          GitHub <ArrowUpRight size={12} aria-hidden="true" />
        </a>
        <a href="#about">О проекте</a>
        <a href="#install">Установить</a>
        <a href="#instructions">Инструкция</a>
      </nav>
    </header>
  )
}
