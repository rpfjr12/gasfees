import type { ApiStatus, HealthResponse } from "./types";
import { Card, CardContent } from "@/components/ui/card";
import { useEffect, useState } from "react";

function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthResponse) => setApiStatus(data?.ok ? "connected" : "error"))
      .catch(() => setApiStatus("error"));
  }, []);

  const dotColor =
    apiStatus === "connected" ? "#22c55e" : apiStatus === "error" ? "#ef4444" : "#ccc";
  const textColor =
    apiStatus === "connected" ? "#16a34a" : apiStatus === "error" ? "#dc2626" : undefined;
  const statusText =
    apiStatus === "checking"
      ? "Checking API\u2026"
      : apiStatus === "connected"
        ? "API connected"
        : "API unreachable";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card>
        <CardContent className="pt-6 text-center">
          <h1 className="text-2xl font-bold text-foreground mb-2">Welcome to your React Web App</h1>
          <p className="text-muted-foreground">Start building something amazing.</p>
          <div className="mt-4 flex items-center justify-center gap-2 text-sm">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: dotColor }}
            />
            <span style={{ color: textColor }}>{statusText}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
