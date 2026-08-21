'use client';

import React from 'react';

/**
 * 轻量 Markdown 渲染器：把 AI 返回的 Markdown 文本渲染成阅读友好的 React 节点，
 * 隐藏 `**`、`#`、`-` 等特殊符号。无第三方依赖，覆盖常见结构：
 * 标题、加粗、斜体、行内代码、代码块、无序/有序列表、引用、链接、段落、分隔线。
 */

type InlineNode = { type: 'text'; value: string } | { type: 'code'; value: string } | { type: 'strong'; value: string } | { type: 'em'; value: string } | { type: 'link'; value: string; href: string };

function parseInline(text: string): InlineNode[] {
  // 先处理行内代码，避免其中的 * 被误解析
  const nodes: InlineNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      nodes.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      nodes.push({ type: 'strong', value: token.slice(2, -2) });
    } else if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      nodes.push({ type: 'em', value: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const close = token.indexOf('](');
      nodes.push({ type: 'link', value: token.slice(1, close), href: token.slice(close + 2, -1) });
    } else {
      nodes.push({ type: 'text', value: token });
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return nodes.filter((n) => !(n.type === 'text' && !n.value));
}

function renderInline(nodes: InlineNode[], keyPrefix: string) {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case 'code':
        return <code key={key} style={inlineCodeStyle}>{node.value}</code>;
      case 'strong':
        return <strong key={key} style={{ fontWeight: 700 }}>{node.value}</strong>;
      case 'em':
        return <em key={key} style={{ fontStyle: 'italic' }}>{node.value}</em>;
      case 'link':
        if (!/^https?:\/\/[^\s]+$/i.test(node.href)) {
          return <span key={key}>{node.value}</span>;
        }
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer" style={{ color: '#6B7FA3', textDecoration: 'underline' }}>
            {node.value}
          </a>
        );
      default:
        return <span key={key}>{node.value}</span>;
    }
  });
}

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.9em',
  background: 'rgba(0,0,0,0.05)',
  padding: '1px 5px',
  borderRadius: 5,
};

function codeBlockStyle(): React.CSSProperties {
  return {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.86em',
    background: 'rgba(0,0,0,0.04)',
    border: '1px solid rgba(0,0,0,0.06)',
    borderRadius: 8,
    padding: '10px 12px',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
    lineHeight: 1.6,
    margin: '8px 0',
  };
}

function renderBlock(line: string, key: number) {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    const sizes: Record<number, number> = { 1: 17, 2: 15.5, 3: 14.5, 4: 13.5, 5: 13, 6: 12.5 };
    return (
      <div key={key} style={{ fontWeight: 700, fontSize: sizes[level] || 13, margin: '10px 0 4px', lineHeight: 1.4 }}>
        {renderInline(parseInline(heading[2]), `h-${key}`)}
      </div>
    );
  }

  if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
    return <div key={key} style={{ height: 1, background: 'rgba(0,0,0,0.08)', margin: '10px 0' }} />;
  }

  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) {
    return (
      <div key={key} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 4 }}>
        <span style={{ color: 'inherit', flexShrink: 0 }}>•</span>
        <span>{renderInline(parseInline(unordered[1]), `li-${key}`)}</span>
      </div>
    );
  }

  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) {
    const num = line.match(/^\s*(\d+)[.)]/)?.[1] ?? '';
    return (
      <div key={key} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 4 }}>
        <span style={{ flexShrink: 0, minWidth: 16, color: 'inherit' }}>{num}.</span>
        <span>{renderInline(parseInline(ordered[1]), `ol-${key}`)}</span>
      </div>
    );
  }

  const quote = line.match(/^\s*>\s?(.+)$/);
  if (quote) {
    return (
      <div key={key} style={{ borderLeft: '3px solid rgba(0,0,0,0.15)', paddingLeft: 10, margin: '6px 0', color: 'inherit', opacity: 0.9 }}>
        {renderInline(parseInline(quote[1]), `q-${key}`)}
      </div>
    );
  }

  if (line.trim()) {
    return <div key={key} style={{ margin: '3px 0' }}>{renderInline(parseInline(line), `p-${key}`)}</div>;
  }
  return null;
}

export function renderMarkdown(markdown: string, containerStyle?: React.CSSProperties): React.ReactNode {
  const text = typeof markdown === 'string' ? markdown : '';
  if (!text.trim()) return null;

  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let blockKey = 0;

  const flushCode = () => {
    if (codeBuffer.length) {
      elements.push(<pre key={`code-${blockKey++}`} style={codeBlockStyle()}>{codeBuffer.join('\n')}</pre>);
      codeBuffer = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushCode();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    const node = renderBlock(line, blockKey++);
    if (node) elements.push(node);
  }
  flushCode();

  return (
    <div style={{ ...containerStyle, wordBreak: 'break-word' }}>
      {elements}
    </div>
  );
}

export default function Markdown({ text, style }: { text: string; style?: React.CSSProperties }) {
  return <>{renderMarkdown(text, style)}</>;
}
