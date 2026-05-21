import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PaginationBar from '../explorer/PaginationBar';
import config from '../../config.json';

const PAGE_SIZE = config.defaultListPageSize;

interface TableSummary { name: string; rowCount: number; }
interface ColumnInfo { cid: number; name: string; typeName: string; notNull: boolean; primaryKey: boolean; }
interface QueryResult {
  columns: string[];
  rows: unknown[][];
  totalRows?: number;
  affectedRows?: number;
  truncated: boolean;
  error?: string;
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400 dark:text-gray-600 italic">NULL</span>;
  }
  const str = String(value);
  const cut = str.length > 160;
  return (
    <span className="font-mono" title={cut ? str : undefined}>
      {cut ? str.slice(0, 160) + '…' : str}
    </span>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400 dark:text-gray-500 italic py-4">No rows.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-100 dark:bg-gray-700 sticky top-0">
            {columns.map((col) => (
              <th key={col} className="text-left px-2 py-1.5 font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-white/[0.03]'}>
              {(row as unknown[]).map((cell, j) => (
                <td key={j} className="px-2 py-1 border border-gray-100 dark:border-gray-700 max-w-xs overflow-hidden align-top">
                  <CellValue value={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryResultPanel({ result }: { result: QueryResult }) {
  if (result.error) {
    return (
      <pre className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-xs font-mono whitespace-pre-wrap break-all">
        {result.error}
      </pre>
    );
  }
  if (result.affectedRows != null) {
    return <p className="text-sm text-green-600 dark:text-green-400 py-2">✓ {result.affectedRows} row(s) affected.</p>;
  }
  if (result.rows.length === 0) {
    return <p className="text-sm text-gray-400 dark:text-gray-500 italic py-2">Query returned no rows.</p>;
  }
  return (
    <div className="space-y-2">
      {result.truncated && (
        <p className="text-xs text-amber-600 dark:text-amber-400">⚠ Showing first 1 000 rows only.</p>
      )}
      <DataTable columns={result.columns} rows={result.rows} />
    </div>
  );
}

export default function SqliteExplorerPage() {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [tableData, setTableData] = useState<QueryResult | null>(null);
  const [dataPage, setDataPage] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'data' | 'schema'>('data');
  const [queryText, setQueryText] = useState('SELECT * FROM folder_items LIMIT 20;');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryRunning, setQueryRunning] = useState(false);

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    try {
      setTables(await invoke<TableSummary[]>('sqlite_list_tables'));
    } catch { /* non-fatal */ } finally {
      setTablesLoading(false);
    }
  }, []);

  useEffect(() => { void loadTables(); }, [loadTables]);

  const selectTable = useCallback(async (name: string) => {
    setSelectedTable(name);
    setDataPage(0);
    setActiveTab('data');
    setSchema([]);
    setTableData(null);
    try {
      setSchema(await invoke<ColumnInfo[]>('sqlite_table_schema', { table: name }));
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!selectedTable) return;
    let cancelled = false;
    setDataLoading(true);
    setTableData(null);
    invoke<QueryResult>('sqlite_query_table', { table: selectedTable, page: dataPage, pageSize: PAGE_SIZE })
      .then((r) => { if (!cancelled) setTableData(r); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDataLoading(false); });
    return () => { cancelled = true; };
  }, [selectedTable, dataPage]);

  const runQuery = useCallback(async () => {
    if (!queryText.trim() || queryRunning) return;
    setQueryRunning(true);
    setQueryResult(null);
    try {
      const result = await invoke<QueryResult>('sqlite_run_query', { sql: queryText });
      setQueryResult(result);
      void loadTables();
    } catch (e) {
      setQueryResult({ columns: [], rows: [], truncated: false, error: String(e) });
    } finally {
      setQueryRunning(false);
    }
  }, [queryText, queryRunning, loadTables]);

  return (
    <div className="space-y-5">
      {/* Top: table browser */}
      <div className="flex gap-4 min-h-[280px]">

        {/* Tables sidebar */}
        <div className="w-52 shrink-0 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tables</span>
            <button onClick={() => void loadTables()} disabled={tablesLoading}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 transition-colors">
              ↻ Refresh
            </button>
          </div>
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden flex-1">
            {tablesLoading ? (
              <div className="flex items-center justify-center h-20 text-xs text-gray-400 dark:text-gray-500">Loading…</div>
            ) : tables.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-xs text-gray-400 dark:text-gray-500">No tables</div>
            ) : tables.map((t) => (
              <button key={t.name} onClick={() => void selectTable(t.name)}
                className={`w-full text-left flex items-center justify-between px-3 py-1.5 text-sm transition-colors border-b border-gray-100 dark:border-gray-700/50 last:border-0 ${
                  selectedTable === t.name
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60'
                }`}>
                <span className="font-mono text-xs truncate">{t.name}</span>
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 ml-2 tabular-nums">
                  {t.rowCount.toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Schema / Data panel */}
        <div className="flex-1 min-w-0">
          {!selectedTable ? (
            <div className="flex items-center justify-center h-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-400 dark:text-gray-500">
              Select a table to inspect
            </div>
          ) : (
            <div className="space-y-3">
              {/* Table name + tab strip */}
              <div className="flex items-center gap-3">
                <code className="font-mono font-semibold text-gray-800 dark:text-gray-100 text-sm">{selectedTable}</code>
                {tableData?.totalRows !== undefined && (
                  <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                    {tableData.totalRows.toLocaleString()} row{tableData.totalRows !== 1 ? 's' : ''}
                  </span>
                )}
                <div className="flex gap-0 ml-auto border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden text-xs">
                  {(['data', 'schema'] as const).map((tab) => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1.5 font-medium capitalize transition-colors ${
                        activeTab === tab
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}>{tab}</button>
                  ))}
                </div>
              </div>

              {/* Schema tab */}
              {activeTab === 'schema' && (
                <div className="overflow-x-auto">
                  {schema.length === 0 ? (
                    <p className="text-sm text-gray-400 dark:text-gray-500 italic">No columns.</p>
                  ) : (
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="bg-gray-100 dark:bg-gray-700">
                          {['#', 'Column', 'Type', 'Not Null', 'PK'].map((h) => (
                            <th key={h} className="text-left px-3 py-1.5 font-semibold text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {schema.map((col, i) => (
                          <tr key={col.name} className={i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-white/[0.03]'}>
                            <td className="px-3 py-1 border border-gray-100 dark:border-gray-700 text-gray-400 dark:text-gray-500 tabular-nums">{col.cid}</td>
                            <td className="px-3 py-1 border border-gray-100 dark:border-gray-700 font-mono font-medium text-gray-800 dark:text-gray-200">{col.name}</td>
                            <td className="px-3 py-1 border border-gray-100 dark:border-gray-700 font-mono text-blue-600 dark:text-blue-400">{col.typeName || <span className="text-gray-400 italic">—</span>}</td>
                            <td className="px-3 py-1 border border-gray-100 dark:border-gray-700 text-center text-green-600 dark:text-green-400">{col.notNull ? '✓' : ''}</td>
                            <td className="px-3 py-1 border border-gray-100 dark:border-gray-700 text-center">{col.primaryKey ? <span title="Primary key">🔑</span> : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Data tab */}
              {activeTab === 'data' && (
                <>
                  {dataLoading ? (
                    <div className="flex items-center justify-center h-24 text-sm text-gray-400 dark:text-gray-500">Loading…</div>
                  ) : tableData ? (
                    <>
                      <DataTable columns={tableData.columns} rows={tableData.rows} />
                      <PaginationBar
                        page={dataPage}
                        total={tableData.totalRows ?? 0}
                        pageSize={PAGE_SIZE}
                        onPage={setDataPage}
                      />
                    </>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Query editor */}
      <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">SQL Query</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">Ctrl+Enter to run · up to 1 000 rows returned</span>
          </div>
          <button
            onClick={() => void runQuery()}
            disabled={queryRunning || !queryText.trim()}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {queryRunning ? '⏳ Running…' : '▶ Run'}
          </button>
        </div>

        {/* Editor */}
        <textarea
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void runQuery();
            }
          }}
          spellCheck={false}
          rows={6}
          className="w-full resize-y p-4 font-mono text-sm leading-relaxed bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-green-300 placeholder-gray-400 dark:placeholder-gray-700 focus:outline-none"
          placeholder="SELECT * FROM folder_items WHERE account_id = '...' LIMIT 20;"
          style={{ minHeight: '110px', maxHeight: '500px' }}
        />

        {/* Results */}
        {queryResult && (
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Results</span>
              {!queryResult.error && queryResult.affectedRows === undefined && (
                <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                  {queryResult.rows.length} row{queryResult.rows.length !== 1 ? 's' : ''}
                  {queryResult.truncated ? ' (truncated to 1 000)' : ''}
                </span>
              )}
            </div>
            <QueryResultPanel result={queryResult} />
          </div>
        )}
      </div>
    </div>
  );
}
