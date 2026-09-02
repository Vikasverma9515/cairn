import { CreateInvoiceButton } from "../../components/CreateInvoiceButton";
import { InvoiceList } from "../../components/InvoiceList";
import { InvoiceWebMcpTools } from "../../components/InvoiceWebMcpTools";
import { listInvoices } from "../../lib/invoices";

export default function InvoicesPage() {
  return (
    <main className="mx-auto max-w-2xl px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Invoices</h1>
      <p className="mt-3 text-gray-600">Every invoice you&apos;ve sent, with its status and amount.</p>
      <div className="mt-6">
        <CreateInvoiceButton />
      </div>
      <div className="mt-6">
        <InvoiceList />
      </div>
      <InvoiceWebMcpTools invoices={listInvoices()} />
    </main>
  );
}
