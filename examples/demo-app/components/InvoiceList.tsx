import { listInvoices } from "../lib/invoices";
import { ArchiveInvoiceButton } from "./ArchiveInvoiceButton";

const statusStyles: Record<string, string> = {
  Paid: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  Overdue: "bg-amber-50 text-amber-700 ring-amber-600/20",
  Archived: "bg-gray-100 text-gray-500 ring-gray-500/20",
};

export function InvoiceList() {
  const invoices = listInvoices();

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm" data-ai="invoice-table">
        <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-3 font-medium">Client</th>
            <th className="px-4 py-3 font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {invoices.map((inv) => (
            <tr key={inv.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-800">{inv.client}</td>
              <td className="px-4 py-3 text-gray-600">{inv.amount}</td>
              <td className="px-4 py-3">
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[inv.status]}`}>
                  {inv.status}
                </span>
              </td>
              <td className="px-4 py-3 text-right">{inv.status !== "Archived" && <ArchiveInvoiceButton id={inv.id} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
