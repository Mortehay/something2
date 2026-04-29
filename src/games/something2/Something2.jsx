import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { Game } from "./src/js/main.js";

const StyledGameContainer = styled.div`
  display: flex;
  height: 100%;
  width: 100%;
  position: relative;
  justify-content: center;
  align-items: center;
  background-color: #1a1a2e;
  overflow: hidden;

  #gameCanvas {
    border: 4px solid #2e2e3e;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    background-color: #1a1a2e;
  }

  /* UI Panels */
  .ui-panel {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(10px);
    border: 3px solid #4a9eff;
    padding: 30px;
    border-radius: 20px;
    text-align: center;
    box-shadow: 0 0 30px rgba(74, 158, 255, 0.2);
    z-index: 1000;
    display: none;
    color: #eee;
    font-family: 'Courier New', Courier, monospace;
  }

  #loadingScreen {
    padding: 50px;
  }

  .ui-panel.active {
    display: block;
  }

  .ui-panel h1 {
    font-size: 4rem;
    margin-bottom: 2rem;
    color: #4a9eff;
    text-shadow: 0 0 10px rgba(74, 158, 255, 0.5);
  }

  .ui-panel h2 {
    font-size: 3.2rem;
    margin-bottom: 1.5rem;
    color: #eee;
  }

  .ui-panel button {
    background: #3a7ed8;
    color: #fff;
    border: 2px solid #4a9eff;
    padding: 1.2rem 2.4rem;
    margin: 0.8rem;
    font-size: 1.6rem;
    cursor: pointer;
    font-family: 'Courier New', Courier, monospace;
    border-radius: 8px;
    transition: all 0.3s ease;
    text-shadow: 0 0 10px rgba(74, 158, 255, 0.5);
  }

  .ui-panel button:hover {
    background: #4a9eff;
    box-shadow: 0 0 20px rgba(74, 157, 255, 0.5);
    transform: translateY(-2px);
  }
`;

function Something2() {
  const gameRef = useRef(null);

  useEffect(() => {
    // Instantiate the game when the component mounts
    gameRef.current = new Game();
    gameRef.current.init();

    // Cleanup when the component unmounts
    return () => {
      if (gameRef.current) {
        gameRef.current.destroy();
      }
    };
  }, []);

  return (
    <StyledGameContainer id="gameContainer">
      <canvas id="gameCanvas" width="800" height="600"></canvas>
      {/*main menu*/}
      <div id="mainMenu" className="ui-panel">
        <h1>Game starter kit</h1>
        <button id="playBtn">Play</button>
        <div style={{ marginTop: "20px", fontSize: "14px", color: "#aaa" }}>
          <div>WASD - Move</div>
          <div>ESC - Pause</div>
        </div>
      </div>
      {/*pause menu*/}
      <div id="pauseMenu" className="ui-panel">
        <h2>Paused</h2>
        <button id="resumeBtn">Resume</button>
        <button id="quitBtn">Quit to Menu</button>
      </div>
      {/*loading screen*/}
      <div id="loadingScreen" className="ui-panel active">
        <h2>Loading...</h2>
        <p id="loadingText">Sharpening the pixels...</p>
      </div>
    </StyledGameContainer>
  )
}

export default Something2;