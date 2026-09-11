export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="fgrid">
          <div className="fbrand-col">
            <svg width="20" height="20" viewBox="0 0 128 128" fill="none">
              <rect width="128" height="128" rx="30" fill="#3B342B" />
              <ellipse cx="64" cy="83" rx="38" ry="17" fill="#fff" fillOpacity="0.6" />
              <ellipse cx="55" cy="61" rx="27" ry="13" fill="#fff" fillOpacity="0.45" />
              <ellipse cx="74" cy="39" rx="17" ry="10" fill="#fff" fillOpacity="0.3" />
            </svg>
            MIT licensed · Cairn contributors
          </div>
          <div className="fcol">
            <div className="ftitle">Product</div>
            <a href="#how">How it works</a>
            <a href="#voice">Voice mode</a>
            <a href="#features">Features</a>
            <a href="#install">Install</a>
            <a href="#deploy">Deploy</a>
          </div>
          <div className="fcol">
            <div className="ftitle">Packages</div>
            <a href="https://www.npmjs.com/package/@cairnvibe/sdk" target="_blank" rel="noopener">
              @cairnvibe/sdk
            </a>
            <a href="https://www.npmjs.com/package/@cairnvibe/core" target="_blank" rel="noopener">
              @cairnvibe/core
            </a>
            <a href="https://www.npmjs.com/package/@cairnvibe/indexer" target="_blank" rel="noopener">
              @cairnvibe/indexer
            </a>
          </div>
          <div className="fcol">
            <div className="ftitle">Docs</div>
            <a href="https://github.com/Vikasverma9515/cairn/blob/main/README.md" target="_blank" rel="noopener">
              Full README
            </a>
            <a href="https://github.com/Vikasverma9515/cairn/blob/main/ROADMAP.md" target="_blank" rel="noopener">
              Roadmap
            </a>
            <a href="https://github.com/Vikasverma9515/cairn/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">
              Contributing
            </a>
          </div>
          <div className="fcol">
            <div className="ftitle">Repo</div>
            <a href="https://github.com/Vikasverma9515/cairn" target="_blank" rel="noopener">
              GitHub
            </a>
            <a href="https://github.com/Vikasverma9515/cairn/issues" target="_blank" rel="noopener">
              Issues
            </a>
            <a href="https://github.com/Vikasverma9515/cairn/blob/main/LICENSE" target="_blank" rel="noopener">
              License
            </a>
          </div>
        </div>
        <div className="fbottom">
          Cairn — an agentic AI copilot for your product. Open source, MIT
          licensed.
        </div>
      </div>
    </footer>
  );
}
