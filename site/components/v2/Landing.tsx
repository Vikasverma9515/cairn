import type { ReactNode } from "react";
import CopyButton from "@/components/CopyButton";
import GradientWaves from "./GradientWaves";
import { Ico, I } from "./icons";
import FeatureWall from "./FeatureWall";
import HowExplorer from "./HowExplorer";
import InstallFolder from "./InstallFolder";
import ScrollStack, { ScrollStackItem } from "./ScrollStack";

const GITHUB = "https://github.com/Vikasverma9515/cairn";
const CMD = "npx @cairnvibe/indexer setup";

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" fill="none" aria-hidden="true">
      <rect width="128" height="128" rx="30" fill="#14110e" stroke="rgba(237,230,218,.14)" />
      <ellipse cx="64" cy="83" rx="38" ry="17" fill="#EDE6DA" />
      <ellipse cx="45" cy="79" rx="18" ry="12" fill="#EDE6DA" />
      <ellipse cx="86" cy="82" rx="15" ry="11" fill="#EDE6DA" />
      <ellipse cx="55" cy="61" rx="27" ry="13" fill="#EDE6DA" fillOpacity="0.82" />
      <ellipse cx="38" cy="58" rx="12" ry="8" fill="#EDE6DA" fillOpacity="0.82" />
      <ellipse cx="75" cy="59" rx="11" ry="8" fill="#EDE6DA" fillOpacity="0.82" />
      <ellipse cx="74" cy="39" rx="17" ry="10" fill="#E07A3F" />
      <ellipse cx="84" cy="36" rx="8" ry="6" fill="#E07A3F" />
    </svg>
  );
}

function Cmd() {
  return (
    <div className="cx-cmd">
      <span>
        <span className="p">$</span> {CMD}
      </span>
      <CopyButton text={CMD} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Nav + Hero                                                          */
/* ------------------------------------------------------------------ */

function Nav() {
  return (
    <header className="cx-nav">
      <div className="cx-wrap">
        <a className="cx-brand" href="#top" aria-label="Cairn home">
          <Mark />
          cairn
        </a>
        <div className="cx-links">
          <a href="#problem">Why</a>
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#install">Install</a>
          <a href="#faq">FAQ</a>
          <a className="cx-gh" href={GITHUB} target="_blank" rel="noopener">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

const invoices = [
  ["INV-2198", "Northwind Traders", "Paid", "$1,240", false],
  ["INV-2201", "Acme Co", "Overdue", "$3,870", true],
  ["INV-2204", "Globex", "Paid", "$920", false],
  ["INV-2207", "Initech", "Overdue", "$2,150", false],
  ["INV-2211", "Umbrella Ltd", "Paid", "$4,600", false],
] as const;

function ProductStage() {
  return (
    <div className="cx-stage">
      <div className="cx-app">
        <div className="cx-chrome">
          <i />
          <i />
          <i />
          <span>app.yourproduct.com/invoices</span>
        </div>
        <aside className="cx-side">
          <b>Ledgerly</b>
          {["Dashboard", "Invoices", "Customers", "Reports", "Settings"].map((n) => (
            <div key={n} className={n === "Invoices" ? "on" : ""}>
              <Ico>{n === "Invoices" ? I.book : I.globe}</Ico>
              {n}
            </div>
          ))}
        </aside>
        <div className="cx-main">
          <h4>Invoices</h4>
          <small>5 of 128 shown · sorted by date</small>
          <table className="cx-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invoices.map(([id, who, status, amt, hit]) => (
                <tr key={id} className={hit ? "hit" : ""}>
                  <td>{id}</td>
                  <td>{who}</td>
                  <td>
                    <span className={`cx-pill ${status === "Paid" ? "paid" : "over"}`}>{status}</span>
                  </td>
                  <td>{amt}</td>
                  <td>
                    <span className="cx-rowbtn">Archive</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cx-widget" aria-label="Cairn assistant">
        <div className="cx-wh">
          <Mark size={22} /> Cairn
          <em>● listening</em>
        </div>
        <div className="cx-wb">
          <div className="cx-you">find the invoice for Acme Co and archive it</div>
          <div className="cx-trace">
            <div>
              <span className="t">planner</span>1. find invoice 2. archive it
            </div>
            <div>
              <span className="t">step 1</span>read <span className="v">invoice-table</span> <span className="ok">✓</span>
            </div>
            <div>
              <span className="t">step 2</span>do <span className="v">archiveInvoice</span> <span className="ok">✓</span>
            </div>
            <div>
              <span className="t">critic</span>
              <span className="ok">✓ task complete</span>
            </div>
          </div>
          <div className="cx-agent">Archived Acme Co&apos;s invoice.</div>
        </div>
        <div className="cx-wf">
          Say it or type it
          <span className="mic">
            <Ico size={14}>{I.mic}</Ico>
          </span>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="cx-hero" id="top">
      <div className="cx-waves" aria-hidden="true">
        <GradientWaves
          horizonColor="#7a3210"
          waveColor="#E07A3F"
          crestColor="#FFB070"
          speed={0.35}
          amplitude={2.4}
          waveScale={0.6}
          waveRatio={0.9}
          swell={35}
          turbulence={20}
          tilt={1.11}
          zoom={1.0}
          height={5.5}
          fogDepth={34}
          detail="medium"
          brightness={1.15}
          opacity={1.0}
          mouseInteraction={false}
          maxDpr={0.75}
          maxFps={30}
          parallaxStrength={0.5}
          grain={true}
          grainIntensity={0.05}
        />
      </div>
      <div className="cx-wrap">
        <span className="cx-badge">
          <span className="cx-dot" /> Vibe using, not vibe coding
        </span>
        <h1 className="cx-h1">
          Don&apos;t learn the software. Just <span className="cx-em">tell it</span> what you want.
        </h1>
        <p className="cx-lede">
          Cairn is an AI agent that lives inside your product and actually uses it for your customer: clicking the real
          buttons, filling the real forms, running the real flow, while they just say what they want.
        </p>
        <div className="cx-actions">
          <a className="cx-btn cx-btn-primary" href="#install">
            Get started
            <Ico size={16}>{I.arrow}</Ico>
          </a>
          <a className="cx-btn cx-btn-ghost" href={GITHUB} target="_blank" rel="noopener">
            View source on GitHub
          </a>
        </div>
        <ProductStage />
        <div className="cx-strip">
          <div>
            <b>16</b>
            <span>fixed verbs, never a click it invented</span>
          </div>
          <div>
            <b>~1.5s</b>
            <span>to first spoken reply, streamed</span>
          </div>
          <div>
            <b>MIT</b>
            <span>open source, live on npm</span>
          </div>
          <div>
            <b>Any</b>
            <span>framework, Next.js goes deeper</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Problem -> solution                                                 */
/* ------------------------------------------------------------------ */

function Problem() {
  return (
    <section className="cx-sec" id="problem">
      <div className="cx-wrap">
        <div className="cx-head">
          <p className="cx-kicker">The problem</p>
          <h2 className="cx-h2">Every new tool starts with a manual.</h2>
          <p className="cx-sub">
            Where is the button? What is it called? Which order do I click? Learning software is the tax on using it.
            Cairn removes the tax.
          </p>
        </div>

        <div className="cx-stack">
          <ScrollStack
            useWindowScroll
            itemDistance={70}
            itemScale={0.03}
            itemStackDistance={26}
            stackPosition="17%"
            scaleEndPosition="8%"
            baseScale={0.9}
          >
            <ScrollStackItem itemClassName="cx-sc bad">
              <div className="cx-sc-grid">
                <div className="cx-sc-copy">
                  <span className="cx-tag">
                    <Ico size={13}>{I.x}</Ico> Without Cairn
                  </span>
                  <h3>Every feature is a button someone has to find.</h3>
                  <p>Dozens of controls, hidden menus and settings named by engineers. Customers guess, give up, or file a ticket.</p>
                </div>
                <div className="cx-sc-viz">
                  <div className="cx-toolbar" aria-hidden="true">
                    {Array.from({ length: 20 }, (_, i) => (
                      <i key={i} className={i === 4 || i === 11 || i === 17 ? "q" : ""} />
                    ))}
                  </div>
                  <div className="cx-stack-rows">
                    <div className="cx-note-row">
                      <Ico>{I.help}</Ico> &ldquo;Where is the archive setting?&rdquo;
                    </div>
                    <div className="cx-note-row">
                      <Ico>{I.play}</Ico> Watch the 12-minute onboarding tutorial
                    </div>
                    <div className="cx-note-row">
                      <Ico>{I.mail}</Ico> Open a support ticket and wait a day
                    </div>
                  </div>
                </div>
              </div>
            </ScrollStackItem>

            <ScrollStackItem itemClassName="cx-sc mid">
              <div className="cx-sc-grid">
                <div className="cx-sc-copy">
                  <span className="cx-tag">
                    <Ico size={13}>{I.mic}</Ico> Say it instead
                  </span>
                  <h3>
                    Now they just say <span className="cx-em">what they want</span>.
                  </h3>
                  <p>Out loud or typed, in their own words. No menu names to remember and no order of clicks to learn.</p>
                </div>
                <div className="cx-sc-viz">
                  <div className="cx-ask">
                    <Ico size={18}>{I.mic}</Ico>
                    archive the invoice for Acme Co
                    <span className="caret" />
                  </div>
                  <div className="cx-chips-row">
                    <span>add Sam to the team</span>
                    <span>export last month&apos;s report</span>
                    <span>mark Globex as paid</span>
                    <span>show me overdue invoices</span>
                  </div>
                  <p className="cx-caption">Any request, in plain language.</p>
                </div>
              </div>
            </ScrollStackItem>

            <ScrollStackItem itemClassName="cx-sc good">
              <div className="cx-sc-grid">
                <div className="cx-sc-copy">
                  <span className="cx-tag">
                    <Ico size={13}>{I.check}</Ico> With Cairn
                  </span>
                  <h3>Cairn does the clicking, then checks its work.</h3>
                  <p>It plans the steps, uses your app&apos;s own actions, and verifies the result before it tells the customer it is done.</p>
                </div>
                <div className="cx-sc-viz">
                  <div className="cx-stack-rows">
                    <div className="cx-note-row">
                      <Ico>{I.check}</Ico> Found INV-2201 in the invoice table
                    </div>
                    <div className="cx-note-row">
                      <Ico>{I.check}</Ico> Ran the app&apos;s own archive action
                    </div>
                    <div className="cx-note-row">
                      <Ico>{I.check}</Ico> Checked the status changed to Archived
                    </div>
                  </div>
                  <div className="cx-done">
                    <Ico size={16}>{I.sparkles}</Ico> Done. In seconds, with no manual.
                  </div>
                </div>
              </div>
            </ScrollStackItem>
          </ScrollStack>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

function How() {
  return (
    <section className="cx-sec" id="how">
      <div className="cx-wrap">
        <div className="cx-head">
          <p className="cx-kicker">How it works</p>
          <h2 className="cx-h2">Three real steps. Nothing improvised.</h2>
          <p className="cx-sub">The agent never guesses at a UI it has not seen. Every step works from a verified map of your app.</p>
        </div>
        <HowExplorer />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Feature wall                                                       */
/* ------------------------------------------------------------------ */

function Features() {
  return (
    <section className="cx-sec" id="features">
      <div className="cx-wrap">
        <div className="cx-head">
          <p className="cx-kicker">What&apos;s running underneath</p>
          <h2 className="cx-h2">Not a demo trick. A real system.</h2>
          <p className="cx-sub">An agent loop, real voice, memory that persists, and hard limits on what it may do. Hover or tap a card to pull it forward.</p>
        </div>
      </div>
      <FeatureWall />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Install, audience, FAQ, closing                                     */
/* ------------------------------------------------------------------ */

function Install() {
  return (
    <section className="cx-sec" id="install">
      <div className="cx-wrap">
        <div className="cx-head">
          <p className="cx-kicker">Install</p>
          <h2 className="cx-h2">One command. Five things happen for you.</h2>
        </div>
        <div className="cx-install">
          <div className="cx-term">
            <div className="cx-chrome">
              <i />
              <i />
              <i />
              <span>bash</span>
            </div>
            <pre>
              <span className="c"># inside an existing Next.js app</span>
              {"\n"}
              <span className="e">$</span> <span className="s">{CMD}</span>
              {"\n\n"}
              <span className="g">✓</span> Installed @cairnvibe/core, indexer, sdk{"\n"}
              <span className="g">✓</span> Provider: Anthropic · key saved (masked){"\n"}
              <span className="g">✓</span> Wired CairnCopilot into app/layout.tsx{"\n"}
              <span className="g">✓</span> Added transpilePackages to next.config{"\n"}
              <span className="g">✓</span> Manifest built · 14 pages, 52 elements{"\n\n"}
              <span className="c">Run your app. The copilot is live.</span>
            </pre>
          </div>
          <InstallFolder />
        </div>
      </div>
    </section>
  );
}

function Audience() {
  const cards = [
    { icon: I.users, t: "For your customers", d: "They don't learn your product. They describe what they want and watch it happen." },
    { icon: I.tool, t: "For you, the builder", d: "Every user gets a product expert without you writing an onboarding flow. Point Cairn at your source once." },
    { icon: I.shield, t: "For your peace of mind", d: "The agent can only take actions you registered, checked server-side. It can never invent a click or run arbitrary code." },
  ];
  return (
    <section className="cx-sec">
      <div className="cx-wrap">
        <div className="cx-aud">
          {cards.map(({ icon, t, d }) => (
            <div key={t}>
              <Ico>{icon}</Ico>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ = [
  ["What does “vibe using” mean?", "Vibe coding is describing the app you want built. Vibe using is describing what you want done, in software you have never opened before. You say it, and an agent does it with the app's real buttons."],
  ["Can it do anything in my app?", "No, and that is the point. It can only take actions you registered, and each one is checked on the server against a fixed schema of 16 verbs. It can never invent a click or run arbitrary code."],
  ["Which frameworks does it support?", "Any. Next.js gets the deepest analysis because Cairn reads the source. Every other framework is mapped by crawling the running app. The widget is <Copilot/> for React or <cairn-widget> for Vue, Angular, Svelte and plain HTML."],
  ["Which AI models and voice does it use?", "You choose the provider: Anthropic, Groq or Gemini. Voice runs on Deepgram speech-to-text and text-to-speech over a persistent connection."],
  ["Is it open source?", "Yes, MIT licensed. It is published on npm as @cairnvibe/core, @cairnvibe/indexer and @cairnvibe/sdk, and the source is on GitHub."],
];

function Faq() {
  return (
    <section className="cx-sec" id="faq">
      <div className="cx-wrap">
        <div className="cx-head">
          <p className="cx-kicker">FAQ</p>
          <h2 className="cx-h2">Questions, answered</h2>
        </div>
        <div className="cx-faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <div className="cx-wrap">
      <div className="cx-final">
        <p className="cx-kicker">Get started</p>
        <h2 className="cx-h2">
          Point it at your app <span className="cx-em">once</span>.
        </h2>
        <p className="cx-sub" style={{ margin: "18px auto 0" }}>
          Every customer then gets an agent that already knows your product.
        </p>
        <div className="cx-actions">
          <Cmd />
          <a className="cx-btn cx-btn-ghost" href={GITHUB} target="_blank" rel="noopener">
            Star on GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="cx-foot">
      <div className="cx-wrap">
        <a className="cx-brand" href="#top">
          <Mark size={26} />
          cairn
        </a>
        <div className="cx-flinks">
          <a href="https://www.npmjs.com/package/@cairnvibe/sdk" target="_blank" rel="noopener">npm</a>
          <a href={`${GITHUB}/blob/main/README.md`} target="_blank" rel="noopener">Docs</a>
          <a href={`${GITHUB}/blob/main/ROADMAP.md`} target="_blank" rel="noopener">Roadmap</a>
          <a href={`${GITHUB}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noopener">Contributing</a>
          <a href={`${GITHUB}/issues`} target="_blank" rel="noopener">Issues</a>
          <a href={`${GITHUB}/blob/main/LICENSE`} target="_blank" rel="noopener">MIT License</a>
        </div>
        <small>Don&apos;t learn the software. Just tell it what you want.</small>
      </div>
    </footer>
  );
}

export default function Landing() {
  return (
    <div className="cx">
      <Nav />
      <main>
        <Hero />
        <Problem />
        <How />
        <Features />
        <Install />
        <Audience />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
