export default function LiveInApp() {
  return (
    <section id="interact">
      <div className="wrap">
        <p className="kicker">Live in your app</p>
        <h2 style={{ maxWidth: "26ch" }}>
          Your customer sees a normal app. Then it just <em>does</em> things.
        </h2>
        <p className="lede">
          The exact widget, the exact conversation shape — a real element
          gets highlighted before anything happens, and the confirmation
          names what actually changed.
        </p>

        <div className="chrome app-mock">
          <div className="chrome-bar">
            <i></i>
            <i></i>
            <i></i>
            <span>yourapp.com/invoices</span>
          </div>
          <div className="app-nav">
            Home{"   "}
            <b>Invoices</b>
            {"   "}Sessions{"   "}Board{"   "}Agents
          </div>
          <div className="app-body">
            <table>
              <tbody>
                <tr>
                  <th>Client</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
                <tr className="hl">
                  <td>Acme Co.</td>
                  <td>$1,200.00</td>
                  <td>
                    <span className="pill overdue">Overdue</span>
                  </td>
                </tr>
                <tr>
                  <td>Globex Inc.</td>
                  <td>$450.00</td>
                  <td>
                    <span className="pill paid">Paid</span>
                  </td>
                </tr>
                <tr>
                  <td>Initech</td>
                  <td>$980.00</td>
                  <td>
                    <span className="pill paid">Paid</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="widget">
            <div className="widget-panel">
              <div className="widget-msgs">
                <div className="msg user">archive the invoice for Acme Co</div>
                <div className="msg agent">
                  <span className="verb-tag">do → archiveInvoice</span>
                  Archived Acme Co's invoice.
                </div>
              </div>
              <div className="widget-input">
                <span className="fake-field">Ask Cairn a question…</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
