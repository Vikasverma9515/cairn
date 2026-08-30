import { CreateInvoiceButton } from "../../components/CreateInvoiceButton";
import { InvoiceList } from "../../components/InvoiceList";

export default function InvoicesPage() {
  return (
    <main style={{ padding: 40, maxWidth: 640 }}>
      <h1>Invoices</h1>
      <p>Every invoice you&apos;ve sent, with its status and amount.</p>
      <CreateInvoiceButton />
      <InvoiceList />
    </main>
  );
}
