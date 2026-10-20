import './splash.css'
import logo from '../assets/logo.svg'

// The originals — credits preserved.
const classics = [
  'Grabbing a cup of coffee',
  'Counting to infinity',
  'Making things look pretty',
  'Feeding the hamsters',
  'Polishing the pixels',
  'Charging the laser',
  'Tuning the warp drive',
  'Waiting for Sebastian to go to the kitchen',
  'Use code pear in the Fortnite item shop',
  'This is a loading screen',
  'This is not a loading screen',
  'Wait, has my mic been on this whole time?',
  'Assembling code monkeys',
  'Warming up the servers',
  'Loading the loading screen',
  'Eating a sandwich',
  'uhh',
  "<span class='rainbow'>RGB loading</span>",
  "<span class='obfuscated'>Loading</span>"
]

// Claude-flavoured additions :>
const claude = [
  'Combobulating keyframes',
  'Clauding',
  "You're absolutely right!",
  'Percolating pixels',
  'Consulting the context window',
  'Asking Claude to render this frame by frame',
  'Noodling on the timeline',
  'Flibbertigibbeting',
  'Reticulating CSS transforms',
  'Thinking really hard about easing curves',
  'Spelunking through the DOM',
  'Herding flicks',
  'Rewriting it in a single div',
  'Writing a 40-line comment about a 2-line fix',
  'Pondering the meaning of z-index',
  "<span class='claude'>✻</span> Moseying",
  'Compacting conversation',
  'Generating a commit message nobody will read',
  "Let me check that file first",
  'Shimmying into position',
  "<span class='claude'>esc</span> to interrupt",
  'Making a todo list for the todo list',
  'Tokenizing your vibes',
  'Honking',
  'One more tool call, promise<span class="blink">_</span>'
]

const all = [...classics, ...claude]
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
