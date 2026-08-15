'use client';

import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] 渲染异常:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FDFCFA',
          fontFamily: '"Playfair Display", Georgia, serif',
        }}>
          <div style={{
            textAlign: 'center',
            padding: '48px 32px',
            maxWidth: 400,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <h2 style={{
              margin: '0 0 12px',
              fontSize: 20,
              fontWeight: 600,
              color: '#3A3840',
            }}>
              页面出错了
            </h2>
            <p style={{
              margin: '0 0 24px',
              fontSize: 13,
              color: '#8C8780',
              lineHeight: 1.6,
            }}>
              {this.state.error?.message || '发生了未知错误'}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                height: 40,
                padding: '0 24px',
                borderRadius: 10,
                border: 'none',
                background: '#829987',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
