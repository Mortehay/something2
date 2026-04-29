import { createContext, useContext, useEffect } from "react";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

const DarkModeContext = createContext();

function DarkModeProvider({ children }) {
    const [isDarkMode, setIsDarkMode] = useLocalStorageState(false,"isDarkMode");

    useEffect(function(){
        document.documentElement.classList.toggle("dark-mode",isDarkMode);
    },[isDarkMode])
    function toggleDarkMode() {
        setIsDarkMode((isDark) => !isDark);
    }
    return (
        <DarkModeContext.Provider value={{isDarkMode, toggleDarkMode}}>
            {children}
        </DarkModeContext.Provider>
    );
}

function useDarkMode() {
    const context = useContext(DarkModeContext);
    if (!context) {
        throw new Error("useDarkMode must be used within a DarkModeProvider");
    }
    return context;
}

export { DarkModeProvider, useDarkMode };