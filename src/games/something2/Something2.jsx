import { useEffect } from 'react';
import { game } from "./src/js/main.js"


function Something2(){
    useEffect(() => {

        if (game && typeof game.init === 'function') {
            game.init();
        }
    }, []);

    return (
        <div id="gameContainer">
            <canvas id="gameCanvas" width="800" height="600"></canvas>
            {/*main menu*/}
            <div id="mainMenu" class="ui-panel">
                <h1>Game starter kit</h1>
                <button id="playBtn">Play</button>
                <div style="margin-top: 20px; font-size: 14px; color: #aaa;">
                    <div>WASD - Move</div>
                    <div>ESC - Pause</div>
                </div>
            </div>
            {/*pause menu*/}
            <div id="pauseMenu" class="ui-panel">
                <h2>Paused</h2>
                <button id="resumeBtn">Resume</button>
                <button id="quitBtn">Quit to Menu</button>
            </div>
            {/*loading screen*/}
            <div id="loadingScreen" class="ui-panel active">
                <h2>Loading...</h2>
                <p id="loadingText">Sharpening the pixels...</p>
            </div>
        </div>
    )
}

export default Something2;