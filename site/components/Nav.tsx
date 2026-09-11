export default function Nav() {
  return (
    <nav>
      <div className="wrap">
        <a className="brand" href="#top">
          <svg width="28" height="28" viewBox="0 0 128 128" fill="none">
            <rect width="128" height="128" rx="30" fill="#1B1815" />
            <ellipse cx="64" cy="83" rx="38" ry="17" fill="#EDE6DA" />
            <ellipse cx="45" cy="79" rx="18" ry="12" fill="#EDE6DA" />
            <ellipse cx="86" cy="82" rx="15" ry="11" fill="#EDE6DA" />
            <ellipse cx="55" cy="61" rx="27" ry="13" fill="#EDE6DA" fillOpacity="0.82" />
            <ellipse cx="38" cy="58" rx="12" ry="8" fill="#EDE6DA" fillOpacity="0.82" />
            <ellipse cx="75" cy="59" rx="11" ry="8" fill="#EDE6DA" fillOpacity="0.82" />
            <ellipse cx="74" cy="39" rx="17" ry="10" fill="#E07A3F" />
            <ellipse cx="84" cy="36" rx="8" ry="6" fill="#E07A3F" />
          </svg>
          <span>cairn</span>
        </a>
        <div className="navlinks">
          <a href="#how">How it works</a>
          <a href="#interact">Live in your app</a>
          <a href="#voice">Voice mode</a>
          <a href="#features">Features</a>
          <a href="#install">Install</a>
          <a href="#deploy">Deploy</a>
          <a
            className="gh"
            href="https://github.com/Vikasverma9515/cairn"
            target="_blank"
            rel="noopener"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
