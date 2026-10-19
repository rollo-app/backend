-- Borrado lógico: el admin puede borrar una foto, pero la fila queda para que siga
-- contando en el cupo del día (borrar no es "repetir") y el id no se pueda reusar.
ALTER TABLE media ADD COLUMN deleted_at INTEGER;
