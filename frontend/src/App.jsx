import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "react-hot-toast";
import GlobalStyles from "./styles/GlobalStyles";
import LoginRoute from "./pages/LoginRoute";
import PageNotFound from "./pages/PageNotFound";
import AppLayout from "./ui/AppLayout";
import RequireAuth from "./ui/RequireAuth";
import RequireAdmin from "./ui/RequireAdmin";
import GameShell from "./games/something2/GameShell";
import GameView from "./games/something2/GameView";
import TileTypesAdmin from "./games/something2/TileTypesAdmin";
import EntityTypesAdmin from "./games/something2/EntityTypesAdmin";
import ItemTypesAdmin from "./games/something2/ItemTypesAdmin";
import MapsAdmin from "./games/something2/MapsAdmin";
import BiomesAdmin from "./games/something2/BiomesAdmin";
import MapGraphAdmin from "./games/something2/MapGraphAdmin";

import { DarkModeProvider } from "./context/DarkModeContext";
import { AuthProvider } from "./context/AuthContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
    },
  },
});

function App() {
  return (
    <DarkModeProvider>
      <QueryClientProvider client={queryClient}>
        <ReactQueryDevtools />
        <GlobalStyles />
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="login" element={<LoginRoute />} />

              <Route element={<RequireAuth />}>
                <Route element={<AppLayout />}>
                  <Route index element={<Navigate replace to="game" />} />

                  {/* Layout route: owns the canvas and the Game instance, so
                      navigating between its children never tears down the
                      running world. See GameShell's canvas comment. */}
                  <Route path="game" element={<GameShell />}>
                    <Route index element={<GameView />} />
                    <Route element={<RequireAdmin />}>
                      <Route path="tiles" element={<TileTypesAdmin />} />
                      <Route path="entities" element={<EntityTypesAdmin />} />
                      <Route path="items" element={<ItemTypesAdmin />} />
                      <Route path="maps" element={<MapsAdmin />} />
                      <Route path="biomes" element={<BiomesAdmin />} />
                      <Route path="world-map" element={<MapGraphAdmin />} />
                    </Route>
                  </Route>
                </Route>
              </Route>

              <Route path="*" element={<PageNotFound />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
        <Toaster position="top-center" gutter={2} containerStyle={{ margin: '8px' }}
          toastOptions={{
            success: { duration: 3000 },
            error: { duration: 5000 },
            style: {
              fontSize: '16px',
              maxWidth: '500px',
              padding: '16px 24px',
              backgroundColor: 'var(--color-grey-0)',
              color: 'var(--color-grey-700)',
            }
          }}
        />
      </QueryClientProvider>
    </DarkModeProvider>
  )
}

export default App
