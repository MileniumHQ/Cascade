import './splash.css'
import logo from '../assets/logo.svg'

// The originals — credits preserved.
const classics = [
  'Grabbing a cup of coffee',
  'Counting to infinity',
  'Making things look pretty',
  'This is a loading screen',
  'This is not a loading screen',
  'Assembling code monkeys',
  'Warming up the servers',
  'Loading the loading screen',
  'Eating a sandwich',
  'uhh',
  "<span class='rainbow'>RGB loading</span>",
  "<span class='obfuscated'>Loading</span>",
  "Initiating spindash",
  "Meow",
  "You're absolutely right!",
  "<span class='claude'>✻</span> Moseying",
  "pxl! pxl! pxl!",
  "Improving your experience"
]


const all = [...classics, ]
const humor = document.getElementById('humor')!
const status = document.getElementById('status')!
const bar = document.getElementById('bar') as HTMLElement
;(document.getElementById('logo') as HTMLImageElement).src = logo

humor.innerHTML = all[Math.floor(Math.random() * all.length)]
const ob = document.querySelector<HTMLElement>('.obfuscated')
if (ob) setInterval(() => (ob.textContent = Math.random().toString(36).substring(2, 11)), 10)

window.cascade?.splash.onProgress?.(({ message, done, total }) => {
  status.textContent = message
  bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`
})
