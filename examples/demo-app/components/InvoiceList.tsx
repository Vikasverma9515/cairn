const DEMO_INVOICES = [
  { id: "inv-1", client: "Acme Co.", amount: "$1,200.00", status: "Paid" },
  { id: "inv-2", client: "Globex Inc.", amount: "$450.00", status: "Overdue" },
];

export function InvoiceList() {
  return (
    <table data-ai="invoice-table">
      <thead>
        <tr>
          <th>Client</th>
          <th>Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {DEMO_INVOICES.map((inv) => (
          <tr key={inv.id}>
            <td>{inv.client}</td>
            <td>{inv.amount}</td>
            <td>{inv.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
