import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode; onClose?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Falha ao exibir a interface.", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="panel" role="alert">
        <h2>
          {this.props.onClose
            ? "Não foi possível abrir este formulário"
            : "Não foi possível exibir a aplicação"}
        </h2>
        <p>Tente novamente. Se o problema continuar, recarregue a página.</p>
        <div className="actions">
          <button onClick={() => this.setState({ failed: false })}>
            Tentar novamente
          </button>
          {this.props.onClose && (
            <button onClick={this.props.onClose}>Fechar</button>
          )}
        </div>
      </section>
    );
  }
}
