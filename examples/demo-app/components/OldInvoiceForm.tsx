// Superseded by CreateInvoiceButton + the /invoices flow. Left in place on
// purpose — this is the planted dead-code fixture `cairn build` should flag
// under manifest.dead.
export function OldInvoiceForm() {
  return (
    <form>
      <input type="text" placeholder="Client name" />
      <button type="submit">Create (old)</button>
    </form>
  );
}
