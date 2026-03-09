import { useState } from 'react';
import { useFrqContext, type FrqFileEntry } from './FrqContext';
import { useLanguage } from './LanguageContext';
import { writeFrq } from '../lib/frq';

interface TreeNode {
    name: string;
    path: string;
    children: Record<string, TreeNode>;
    file?: FrqFileEntry;
}

const buildTree = (files: FrqFileEntry[]) => {
    const root: TreeNode = { name: 'root', path: '', children: {} };
    for (const file of files) {
        const parts = file.path.split('/');
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!current.children[part]) {
                current.children[part] = {
                    name: part,
                    path: parts.slice(0, i + 1).join('/'),
                    children: {},
                };
            }
            current = current.children[part];
            if (i === parts.length - 1) current.file = file;
        }
    }
    return root;
};

const downloadFrq = (entry: FrqFileEntry) => {
    const blob = new Blob([writeFrq(entry.frqData)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

const TreeItem = ({
    node,
    activeId,
    onSelect,
    depth = 0,
}: {
    node: TreeNode;
    activeId: string | null;
    onSelect: (id: string) => void;
    depth?: number;
}) => {
    const [isOpen, setIsOpen] = useState(true);
    const isFile = Boolean(node.file);
    const hasChildren = Object.keys(node.children).length > 0;
    const isActive = isFile && activeId === node.file!.id;

    if (node.name === 'root') {
        return (
            <>
                {Object.values(node.children).map(child => (
                    <TreeItem key={child.path} node={child} activeId={activeId} onSelect={onSelect} depth={depth} />
                ))}
            </>
        );
    }

    return (
        <div>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: `5px 8px 5px ${8 + depth * 14}px`,
                    background: isActive ? '#dce8ff' : 'transparent',
                    borderBottom: '1px solid #eee',
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
                onClick={() => {
                    if (isFile) onSelect(node.file!.id);
                    else if (hasChildren) setIsOpen(open => !open);
                }}
            >
                {!isFile && (
                    <span style={{ fontSize: '10px', color: '#888', width: 14, flexShrink: 0 }}>
                        {isOpen ? '▼' : '▶'}
                    </span>
                )}
                {isFile && <span style={{ width: 14, flexShrink: 0 }} />}

                <span
                    style={{
                        flex: 1,
                        fontSize: '13px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: isActive ? '#003580' : '#333',
                        fontWeight: isFile ? 'normal' : '600',
                    }}
                >
                    {isFile ? node.file!.name : node.name}
                </span>

                {isFile && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 4 }}>
                        {node.file!.wavFile && <span style={{ fontSize: '10px', color: '#0dcaf0' }}>WAV</span>}
                        {node.file!.isModified && (
                            <span style={{ fontSize: '11px', color: '#28a745', fontWeight: 'bold' }}>*</span>
                        )}
                        <button
                            title={node.file!.name}
                            onClick={event => {
                                event.stopPropagation();
                                downloadFrq(node.file!);
                            }}
                            style={{
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                fontSize: '13px',
                                padding: '0 2px',
                                lineHeight: 1,
                                color: '#555',
                            }}
                        >
                            ↓
                        </button>
                    </span>
                )}
            </div>

            {!isFile && isOpen && (
                <div>
                    {Object.values(node.children).map(child => (
                        <TreeItem key={child.path} node={child} activeId={activeId} onSelect={onSelect} depth={depth + 1} />
                    ))}
                </div>
            )}
        </div>
    );
};

export const Sidebar = () => {
    const { files, activeFileId, setActiveFile } = useFrqContext();
    const { t } = useLanguage();
    const tree = buildTree(files);

    return (
        <div style={{ width: '220px', borderRight: '1px solid #ddd', background: '#fafafa', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: '8px 10px', fontWeight: '600', fontSize: '12px', color: '#555', borderBottom: '1px solid #ddd', letterSpacing: '0.03em' }}>
                {t('sidebarTitle', { count: files.length })}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {files.length === 0 ? (
                    <div style={{ padding: '16px 10px', color: '#aaa', fontSize: '13px', lineHeight: 1.6 }}>
                        {t('sidebarEmpty')}
                    </div>
                ) : (
                    <TreeItem node={tree} activeId={activeFileId} onSelect={setActiveFile} />
                )}
            </div>
        </div>
    );
};
