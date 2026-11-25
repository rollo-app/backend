-- Which vertical part of the 3:4 cover shows in the wide card of the rollos list: 0 = top, 1 = bottom; NULL = middle.
ALTER TABLE trips ADD COLUMN cover_focus_y REAL;
