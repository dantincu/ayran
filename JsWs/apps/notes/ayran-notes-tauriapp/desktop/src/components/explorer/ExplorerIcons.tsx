type P = { className?: string };
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const UploadIcon       = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M7 10V3M4 6l3-3 3 3M2 12h10"/></svg>;
export const FolderPlusIcon   = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M1 3.5A1.5 1.5 0 012.5 2H5L6.5 4H12A1.5 1.5 0 0113.5 5.5V11A1.5 1.5 0 0112 12.5H2.5A1.5 1.5 0 011 11V3.5z"/><path d="M7 7v3M5.5 8.5h3"/></svg>;
export const PencilIcon       = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M9.5 2.5l2 2L4 12H2V10L9.5 2.5z"/></svg>;
export const TypeCursorIcon   = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M4.5 2h5M7 2v10M4.5 12h5"/></svg>;
export const CopyFilesIcon    = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><rect x="4.5" y="4.5" width="8" height="8" rx="1"/><path d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6.5a1 1 0 001 1H4.5"/></svg>;
export const MoveArrowIcon    = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M2 7h10M8 3.5l3.5 3.5L8 10.5"/></svg>;
export const DownloadArrowIcon= ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M7 2v8M4 8l3 3 3-3M2 12h10"/></svg>;
export const TrashIcon        = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M2 3.5h10M5 3.5V2h4v1.5M4.5 3.5v7.5a1 1 0 001 1h3a1 1 0 001-1V3.5"/><path d="M6 6v3M8 6v3"/></svg>;
export const DotsHorizontalIcon=({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" fill="currentColor"><circle cx="2.5" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11.5" cy="7" r="1.3"/></svg>;
export const ArrowUpIcon      = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M7 11V3M3.5 6.5L7 3l3.5 3.5"/></svg>;
export const ArrowDownIcon    = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M7 3v8M3.5 7.5L7 11l3.5-3.5"/></svg>;
export const ClipboardCopyIcon= ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M9 2H5a1 1 0 00-1 1v8a1 1 0 001 1h7a1 1 0 001-1V6L9 2z"/><path d="M9 2v4h4"/></svg>;
export const AncestorsIcon    = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M2 3h10M2 7h7M2 11h4"/></svg>;
export const NewFileIcon      = ({ className = 'w-3.5 h-3.5' }: P) => <svg className={className} viewBox="0 0 14 14" {...S}><path d="M8 1.5H3a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1V6L8 1.5z"/><path d="M8 1.5V6h4.5"/><path d="M5 8.5h4M7 6.5v4"/></svg>;
