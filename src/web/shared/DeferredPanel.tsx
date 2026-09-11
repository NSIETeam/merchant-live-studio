import React, { Component, Suspense, type ReactNode } from "react";
class PanelError extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section className="card" role="alert">
          <h2>页面暂时无法打开</h2>
          <p>请检查网络后重新加载。重新加载会丢失当前未保存的输入。</p>
          <button
            className="secondary"
            onClick={() => window.location.reload()}
          >
            重新加载页面
          </button>
          <p className="muted">也可以通过导航继续使用其他功能。</p>
        </section>
      );
    return this.props.children;
  }
}
export function DeferredPanel({ children }: { children: ReactNode }) {
  return (
    <PanelError>
      <Suspense
        fallback={
          <div className="card" role="status" aria-live="polite">
            正在载入页面…
          </div>
        }
      >
        {children}
      </Suspense>
    </PanelError>
  );
}
