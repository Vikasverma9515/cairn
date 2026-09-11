export default function Voice() {
  return (
    <section id="voice">
      <div className="wrap">
        <p className="kicker">Voice mode</p>
        <h2 style={{ maxWidth: "24ch" }}>
          Not a mic button bolted on. A real conversation.
        </h2>
        <p className="lede">
          A persistent WebSocket, not a buffered clip — streaming starts in
          ~1–1.5s instead of a 5–10s wait. Talk over it mid-sentence and it
          stops immediately.
        </p>

        <div className="chrome voice-mock">
          <div className="mic-ring">
            <div className="mic-inner">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#14110E"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19v3" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <rect x="9" y="2" width="6" height="13" rx="3" />
              </svg>
            </div>
          </div>
          <div className="status">● Listening…</div>
          <div className="waveform">
            <i></i>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
            <i></i>
          </div>
          <p className="transcript">
            "…and can you read me back what's overdue this month?"
          </p>
          <div className="badges">
            <span className="badge">barge-in ready</span>
            <span className="badge">tours narrated live</span>
            <span className="badge">memory across turns</span>
            <span className="badge">Deepgram STT/TTS</span>
          </div>
        </div>
      </div>
    </section>
  );
}
