function generateWFC(rows, cols, tileTypes) {
    const tileNames = Object.keys(tileTypes);
    const grid = Array(rows).fill(null).map(() => 
        Array(cols).fill(null).map(() => [...tileNames])
    );

    const getEntropy = (r, c) => grid[r][c].length;

    const getLowestEntropyCoords = () => {
        let minEntropy = Infinity;
        let coords = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c].length > 1) {
                    const entropy = getEntropy(r, c);
                    if (entropy < minEntropy) {
                        minEntropy = entropy;
                        coords = [[r, c]];
                    } else if (entropy === minEntropy) {
                        coords.push([r, c]);
                    }
                }
            }
        }
        return coords.length > 0 ? coords[Math.floor(Math.random() * coords.length)] : null;
    };

    const propagate = (r, c) => {
        const stack = [[r, c]];
        while (stack.length > 0) {
            const [currR, currC] = stack.pop();
            const currOptions = grid[currR][currC];

            const neighbors = [
                [currR - 1, currC], [currR + 1, currC],
                [currR, currC - 1], [currR, currC + 1]
            ];

            for (const [nR, nC] of neighbors) {
                if (nR >= 0 && nR < rows && nC >= 0 && nC < cols) {
                    const neighborOptions = grid[nR][nC];
                    if (neighborOptions.length <= 1) continue;

                    const validForNeighbor = new Set();
                    currOptions.forEach(opt => {
                        const allowedNeighbors = tileTypes[opt]?.validNeighbors || [];
                        allowedNeighbors.forEach(validOpt => validForNeighbor.add(validOpt));
                    });

                    const nextNeighborOptions = neighborOptions.filter(opt => validForNeighbor.has(opt));

                    if (nextNeighborOptions.length < neighborOptions.length) {
                        grid[nR][nC] = nextNeighborOptions;
                        stack.push([nR, nC]);
                    }
                }
            }
        }
    };

    let next;
    while (next = getLowestEntropyCoords()) {
        const [r, c] = next;
        const options = grid[r][c];
        const pick = options[Math.floor(Math.random() * options.length)];
        grid[r][c] = [pick];
        propagate(r, c);
    }

    return grid.map(row => row.map(cell => cell[0] || tileNames[0] || 'grass'));
}

module.exports = { generateWFC };

