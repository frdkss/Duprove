import Header from './components/Header/Header'
import Hero from './components/Hero/Hero'
import About from './components/About/About'
import Installation from './components/Installation/Installation'
import Instructions from './components/Instructions/Instructions'
import Footer from './components/Footer/Footer'
import './App.css'

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <Header />
      <main id="main" className="page mx-auto">
        <Hero />
        <About />
        <Installation />
        <Instructions />
        <Footer />
      </main>
    </>
  )
}
