import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Link } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const History = lazy(() => import("./pages/History"));

function NavHeader() {
  return (
    <nav className="border-b border-white/10 bg-zinc-950/45 shadow-[0_8px_32px_rgba(0,0,0,0.3)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-6 md:px-10">
        <Link href="/dashboard" className="text-xl font-bold uppercase tracking-widest text-amber-500 transition-colors hover:text-amber-300">
          SolarControl
        </Link>
        <div className="flex gap-6">
          <Link href="/dashboard" className="font-medium tracking-tight text-zinc-300 transition-colors hover:text-zinc-100">
            Dashboard
          </Link>
          <Link href="/history" className="font-medium tracking-tight text-zinc-300 transition-colors hover:text-zinc-100">
            History
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Router() {
  return (
    <>
      <NavHeader />
      <Suspense
        fallback={
          <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-zinc-950 text-zinc-200">
            Loading workspace...
          </div>
        }
      >
        <Switch>
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/history" component={History} />
          <Route path="/" component={Dashboard} />
          <Route path="/404" component={NotFound} />
          {/* Final fallback route */}
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
