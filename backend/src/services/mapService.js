const TILE_TYPES = {
    grass:{
        color:"#00FF00",
        walkable:true,
        speed:1,
        image:"",
        validNeighbors: ['grass', 'highgrass', 'leafs', 'sand', 'earth']
    }, 
    highgrass:{
        color:"#035c03ff",
        walkable:true,
        speed:0.8,
        image:"",
        validNeighbors: ['highgrass', 'grass', 'leafs', 'swamp']
    }, 
    leafs:{
        color:"#023b02ff",
        walkable:true,
        speed:0.8,
        image:"",
        validNeighbors: ['leafs', 'highgrass', 'grass', 'dirt']
    }, 
    sand:{
        color:"#FFFF00",
        walkable:true,
        speed:0.6,
        image:"",
        validNeighbors: ['sand', 'grass', 'earth', 'water']
    }, 
    rocks:{
        color:"#808080", // changed to grey to avoid being brown like earth
        walkable:true,
        speed:0.8,
        image:"",
        validNeighbors: ['rocks', 'earth', 'snow', 'dirt']
    }, 
    earth:{
        color:"#8B4513",
        walkable:true,
        speed:1,
        image:"",
        validNeighbors: ['earth', 'grass', 'sand', 'rocks', 'dirt', 'swamp']
    },
    dirt:{
        color:"#301604ff",
        walkable:true,
        speed:0.6,
        image:"",
        validNeighbors: ['dirt', 'earth', 'rocks', 'leafs', 'swamp']
    }, 
    snow:{
        color:"#FFFFFF",
        walkable:true,
        speed:0.5,
        image:"",
        validNeighbors: ['snow', 'rocks', 'ice']
    }, 
    ice:{
        color:"#bae6fd", // changed to ice blue
        walkable:true,
        speed:0.2,
        image:"",
        validNeighbors: ['ice', 'snow', 'water']
    },
    swamp:{
        color:"#4d7c0f", // changed to dark swampy green
        walkable:true,
        speed:0.1,
        image:"",
        validNeighbors: ['swamp', 'earth', 'dirt', 'water', 'highgrass']
    },
    water:{
        color:"#3b82f6", // changed to water blue
        walkable:false,
        speed:0,
        image:"",
        validNeighbors: ['water', 'sand', 'ice', 'swamp']
    },
};

function generateWFC(rows, cols) {
    const grid = Array(rows).fill(null).map(() => 
        Array(cols).fill(null).map(() => [...Object.keys(TILE_TYPES)])
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
                        const allowedNeighbors = TILE_TYPES[opt]?.validNeighbors || [];
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

    return grid.map(row => row.map(cell => cell[0] || 'grass'));
}

module.exports = { generateWFC, TILE_TYPES };
