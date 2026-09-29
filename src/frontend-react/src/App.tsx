import ApiHealth from './components/ApiHealth'
import { AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import AuthButton from './components/AuthButton';
import HelloPanel from './components/HelloPanel'
import heroImg from './assets/hero.png'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'

function App() {
  return (
    <>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Hello from React</h1>
        </div>
      </section>

      <div className="ticks"></div>

      <section id="hello-panel">
        <AuthButton />
        <AuthenticatedTemplate>
            <HelloPanel />
        </AuthenticatedTemplate>
        <UnauthenticatedTemplate>
            <p>Sign in to get a greeting from the Python API.</p>
        </UnauthenticatedTemplate>
      </section>

      <section id="api-health">
        <ApiHealth />
      </section>

      <div className="ticks"></div>
      <section id="spacer"></section>
    </>
  )
}

export default App
