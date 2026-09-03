import { BoardColumns } from "../../components/BoardColumns";
import { listBoard } from "../../lib/board";

export default function BoardPage() {
  const columns = listBoard();

  return (
    <main className="mx-auto max-w-4xl px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Board</h1>
      <p className="mt-3 text-gray-600">Track work across columns — move cards, add new ones, edit details.</p>
      <div className="mt-6">
        <BoardColumns columns={columns} />
      </div>
    </main>
  );
}
