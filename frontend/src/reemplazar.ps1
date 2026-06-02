(Get-Content GestionProductos.js) -replace "const API = 
'http://localhost:5000/api'", "const API = process.env.REACT_APP_API_URL || 'http://localhost:5000/api'" | Set-Content GestionProductos.js