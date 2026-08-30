import { listInvoices } from "../lib/invoices";
import { ArchiveInvoiceButton } from "./ArchiveInvoiceButton";

export function InvoiceList() {
  const invoices = listInvoices();

  return (
    <table data-ai="invoice-table">
      <thead>
        <tr>
          <th>Client</th>
          <th>Amount</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id}>
            <td>{inv.client}</td>
            <td>{inv.amount}</td>
            <td>{inv.status}</td>
            <td>{inv.status !== "Archived" && <ArchiveInvoiceButton id={inv.id} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
